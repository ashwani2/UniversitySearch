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
    const { query } = req.body;

    if (!query) {
      return res.status(400).json({
        success: false,
        message: "Query is required",
      });
    }

    const prompt = `
You are an AI university and course finder.

Based on the user query, return universities and matching courses.

IMPORTANT RULES:
1. Return ONLY valid JSON.
2. Do NOT add markdown.
3. Do NOT add explanation text.
4. Return minimum 5 universities in UK.
5. If user searches courses, include universities.
6. If user searches universities, include related courses.
7. Price should be realistic tuition estimate.
8. Keep same response format exactly.
9. Price should be in GBP.

Response format:

[
  {
    "universityName": "",
    "location": "",
    "courses": [
      {
        "courseName": "",
        "price": ""
      }
    ]
  }
]

User Query:
"${query}"
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

        temperature: 0.5,
      });

    let content =
      response.choices[0].message.content;

    /**
     * CLEAN RESPONSE
     */
    content = content
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

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

    // Build a simple, clean prompt
    const prompt = `Write a Statement of Purpose for a student.

Student: ${studentData.name || 'Student'}
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