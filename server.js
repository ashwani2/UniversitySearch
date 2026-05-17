import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

dotenv.config();

const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

app.listen(process.env.PORT || 3000, () => {
  console.log(
    `Server running on port ${process.env.PORT || 3000}`
  );
});