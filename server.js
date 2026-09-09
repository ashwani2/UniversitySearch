import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import fs from "fs";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const sopTemplate = fs.readFileSync(
  path.join(__dirname, "public" ,"templates", "sop-template.docx"),
  "utf8"
);

const sampleSop = fs.readFileSync(
  path.join(__dirname, "public" ,"templates", "sample-sop.docx"),
  "utf8"
);

app.use(cors());

// Serve static files
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

/**
 * GROQ CLIENT
 */
const groq = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

/**
 * Groq retires models on its own schedule, and a retired id fails at request
 * time with a 404 ("the model does not exist"), not at startup — so the service
 * looks healthy while every search fails. Keeping it in env means the fix is a
 * config change and a restart.
 *
 * Check what the key can actually reach with:
 *   curl -s https://api.groq.com/openai/v1/models -H "Authorization: Bearer $GROQ_API_KEY"
 *
 * The llama-3.x and gemma2 ids this used to hardcode were all decommissioned.
 */
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";

/**
 * THROUGHPUT BUDGET — read this before raising any limit here.
 *
 * The Groq key is capped at 8000 tokens/minute (and 1000 requests/day), shared
 * by every user of the site. That per-minute ceiling, not the model's 65536
 * output limit, is what decides how many people can search at once.
 *
 * Measured before tuning: one search cost 6681 tokens (563 prompt + 6118
 * completion, of which 4065 were REASONING). That is 83% of the minute budget
 * for a single query — roughly one search per minute for the whole site.
 *
 * gpt-oss is a reasoning model and spends completion tokens thinking before it
 * emits anything; the llama-3.3-70b it replaced did not, which is why the old
 * 7000 budget used to be enough.
 *
 * Three levers, in order of effect:
 *  1. reasoning_effort "low" — this is structured extraction, not a task where
 *     deliberation improves the answer. Removes the single largest cost.
 *  2. fewer universities per response — output scales linearly with the count,
 *     and a UI list of 10 is as useful as 20.
 *  3. the cache below — a repeated query costs zero tokens, which matters most
 *     because popular searches repeat constantly.
 *
 * Raising SEARCH_MAX_TOKENS above ~7000 is self-defeating: a single request that
 * large cannot fit inside the 8000/min bucket and will 429.
 */
const REASONING_EFFORT = process.env.GROQ_REASONING_EFFORT || "low";
const SEARCH_MAX_TOKENS = Number(process.env.SEARCH_MAX_TOKENS || 6000);
const SOP_MAX_TOKENS = Number(process.env.SOP_MAX_TOKENS || 6000);
const SEARCH_RESULT_COUNT = Number(process.env.SEARCH_RESULT_COUNT || 10);

/**
 * Result cache. Searches cluster hard on a few course/city combinations, so the
 * hit rate is high and every hit is a request that costs no tokens and returns
 * instantly. Keyed on the normalised query so "Data Science" and "data  science"
 * share an entry.
 *
 * Deliberately in-process: one small instance, one service, and a cold cache
 * after a deploy is harmless. Redis would be more machinery than this earns.
 */
const CACHE_TTL_MS = Number(process.env.SEARCH_CACHE_TTL_MS || 24 * 60 * 60 * 1000);
const CACHE_MAX_ENTRIES = Number(process.env.SEARCH_CACHE_MAX || 500);
const searchCache = new Map();

function cacheKey(query, country, city) {
  return [query, country, city]
    .map((s) => (s || "").toLowerCase().trim().replace(/\s+/g, " "))
    .join("|");
}

function cacheGet(key) {
  const hit = searchCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expires) {
    searchCache.delete(key);
    return null;
  }
  // Refresh insertion order so the LRU eviction below keeps hot entries.
  searchCache.delete(key);
  searchCache.set(key, hit);
  return hit.payload;
}

function cacheSet(key, payload) {
  if (searchCache.size >= CACHE_MAX_ENTRIES) {
    // Map preserves insertion order, so the first key is the least recently used.
    searchCache.delete(searchCache.keys().next().value);
  }
  searchCache.set(key, { payload, expires: Date.now() + CACHE_TTL_MS });
}

/** Groq rejects reasoning_effort on models that don't reason; "" opts out. */
const reasoningParams = REASONING_EFFORT
  ? { reasoning_effort: REASONING_EFFORT }
  : {};

/**
 * finish_reason "length" means the budget ran out mid-answer. Worth logging
 * loudly: the JSON slice below can still yield parseable output from a truncated
 * response, so this otherwise fails silently as "fewer results than asked for".
 */
function warnIfTruncated(response, label) {
  const reason = response?.choices?.[0]?.finish_reason;
  if (reason === "length") {
    console.warn(
      `[${label}] TRUNCATED: hit the token limit. reasoning=${response?.usage?.completion_tokens_details?.reasoning_tokens ?? "?"} ` +
        `completion=${response?.usage?.completion_tokens ?? "?"}. Raise SEARCH_MAX_TOKENS/SOP_MAX_TOKENS.`,
    );
  }
  return reason;
}

app.get("/", (req, res) => {
  res.send("Groq AI University Search API Running");
});

/**
 * POST /search
 */
app.post("/search", async (req, res) => {
  try {
    const { query, country, city } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: "Query is required",
      });
    }

    // Serve repeats for free. This is the main reason more than one person a
    // minute can use the search at all.
    const key = cacheKey(query, country, city);
    const cached = cacheGet(key);
    if (cached) {
      return res.json({ ...cached, cached: true });
    }

    // Location is optional so older clients still work, but when present it
    // scopes the results to the country/city the student chose.
    const locationLine = [city, country].filter(Boolean).join(", ");
    const locationClause = locationLine
      ? `The student wants to study in ${locationLine}. Only return universities located there (in ${city || "that city"}${country ? `, ${country}` : ""}).`
      : `Infer the country from the query; if none is given, use the United Kingdom.`;

    const prompt = `
You are an AI university and course finder.

Based on the user query, return universities and matching courses for the requested course and location.

${locationClause}

IMPORTANT RULES:
1. Return ONLY valid JSON — a single array. No markdown, no code fences, no explanation.
2. Return exactly ${SEARCH_RESULT_COUNT} universities (fewer only if the location genuinely has fewer). Include well-known and lesser-known institutions.
3. Every university MUST actually be located in the requested city/country.
4. For each university include 1-3 courses that match the query.
5. "price" is a realistic ANNUAL international tuition fee as a ready-to-display string that INCLUDES the local currency symbol, e.g. "£34,000" or a range "£34,000–£38,000" for the UK, "$40,000" for the USA, "CA$38,000" for Canada, "A$45,000" for Australia, "€18,000" for the EU. Use the currency of the university's country.
6. "location" is the university's city and country.
7. "websiteName" is the university's official website domain ONLY — e.g. "hull.ac.uk" or "ox.ac.uk". No "https://", no path, no full URL.
8. "imageUrl" is a direct https URL to the university's official logo or a campus photo ONLY IF you are certain it is a real, working image URL; if unsure, use "" (empty string). NEVER invent or guess image URLs.
9. "knownFor" is ONE short, factual sentence (max ~120 characters) describing what the university is best known for — its strongest fields, research, or reputation.
10. Keep the response format EXACTLY as shown below.

Response format:

[
  {
    "universityName": "",
    "location": "",
    "websiteName": "",
    "imageUrl": "",
    "knownFor": "",
    "courses": [
      {
        "courseName": "",
        "price": ""
      }
    ]
  }
]

User Query (course): "${query}"${locationLine ? `\nLocation: ${locationLine}` : ""}
`;

    const response =
      await groq.chat.completions.create({
        model: GROQ_MODEL,

        messages: [
          {
            role: "system",
            content:
              "You are a strict JSON API generator.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],

        temperature: 0.3,
        ...reasoningParams,
        // Room for 20+ universities of JSON (now incl. websiteName + knownFor)
        // so the array isn't truncated mid-object (which would fail to parse).
        max_tokens: SEARCH_MAX_TOKENS,
      });

    warnIfTruncated(response, "search");
    let content =
      response.choices[0].message.content;

    /**
     * CLEAN RESPONSE
     * Strip code fences, then slice to the outermost [ ... ] so any stray
     * prose before/after the array doesn't break JSON.parse.
     */
    content = content
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    const start = content.indexOf("[");
    const end = content.lastIndexOf("]");
    if (start !== -1 && end !== -1 && end > start) {
      content = content.slice(start, end + 1);
    }

    let parsed;

    try {
      parsed = JSON.parse(content);
    } catch (err) {
      return res.status(500).json({
        success: false,
        message: "Invalid JSON returned",
        raw: content,
      });
    }

    const payload = {
      success: true,
      total: parsed.length,
      results: parsed,
      usage: response.usage,
    };
    // Only successful, parsed results are cached — never an error or a partial.
    cacheSet(key, payload);
    return res.json(payload);
  } catch (error) {
    console.log(error);

    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

// SIMPLIFIED WORKING VERSION
app.post("/generate-sop", async (req, res) => {
  try {
    const { studentData } = req.body;

    // The frontend sends the applicant's name as `fullName`; keep `name` as a
    // fallback for older callers. Without this the name resolves to the literal
    // "Student" and gets repeated throughout the introduction.
    const studentName =
      (studentData.fullName || studentData.name || "").trim() || "the applicant";

    // Build a simple, clean prompt
    const prompt = `Write a Statement of Purpose for a student named ${studentName}.

Refer to the applicant by their name, ${studentName}, in the introduction. Write in the first person as ${studentName}. Do NOT use the placeholder word "Student" as their name.

Student: ${studentName}
Country to study: ${studentData.country}
University: ${studentData.university}
Course: ${studentData.course}
Campus: ${studentData.campus}

Write with these headings (use markdown # and ##):
# Statement of Purpose
## Introduction
## Why Study in ${studentData.country}
## Why Not Home Country
## Why ${studentData.university}
## Why ${studentData.course}
## Why ${studentData.campus}
## Future Plans
## Conclusion

Write 1200-1800 words. Use paragraphs. No bullet points.`;

    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: SOP_MAX_TOKENS,
      ...reasoningParams,
    });

    warnIfTruncated(response, "generate-sop");
    const sop = response.choices[0].message.content;

    res.json({ success: true, sop });

  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Add this test endpoint temporarily
app.get("/test-groq", async (req, res) => {
  try {
    const testResponse = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        {
          role: "user",
          content: "Say 'Hello, Groq API is working!'"
        }
      ],
      max_tokens: 50,
    });
    
    res.json({
      success: true,
      response: testResponse.choices[0].message.content
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      details: error.response?.data || error
    });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log(
    `Server running on port ${process.env.PORT || 3000}`
  );
});