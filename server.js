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
2. Return AS MANY relevant universities as you can — at least 20 (include well-known and lesser-known institutions in the location). Never return fewer than 20 unless the location genuinely has fewer.
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
        model: "llama-3.3-70b-versatile",

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
        // Room for 20+ universities of JSON (now incl. websiteName + knownFor)
        // so the array isn't truncated mid-object (which would fail to parse).
        max_tokens: 7000,
      });

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

    return res.json({
      success: true,
      total: parsed.length,
      results: parsed,
      usage: response.usage,
    });
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
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
      max_tokens: 4000,
    });

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
      model: "llama-3.3-70b-versatile",
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