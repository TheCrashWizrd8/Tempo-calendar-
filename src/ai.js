import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";

/** One structured-output call. Server-side fallbacks re-run the request on another model if it is declined. */
async function ask({ system, content, schema, effort = "medium" }) {
  const res = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort, format: betaZodOutputFormat(schema) },
    system,
    messages: [{ role: "user", content }],
  });
  if (res.stop_reason === "refusal") throw new Error("The model declined this request.");
  if (res.stop_reason === "max_tokens") throw new Error("The response was cut off; try a smaller input.");
  if (!res.parsed_output) throw new Error("Could not parse the model's answer.");
  return res.parsed_output;
}

// ---------- 1. Screenshot -> events ----------
const ExtractedEvents = z.object({
  events: z.array(z.object({
    title: z.string(),
    start: z.string().describe("Local wall-clock time, ISO 'YYYY-MM-DDTHH:MM' (or 'YYYY-MM-DD' if all_day)"),
    end: z.string().describe("Same format as start. If unknown, assume 1 hour after start."),
    all_day: z.boolean(),
    location: z.string().nullable(),
    notes: z.string().nullable(),
    recurrence: z.string().nullable().describe("An RRULE like 'RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261215T235959Z' for repeating items such as class schedules, else null"),
    confidence: z.enum(["high", "medium", "low"]),
  })),
  notes_for_user: z.string().describe("Short note about anything ambiguous, or empty"),
});

export async function extractEventsFromImage({ base64, mediaType, timezone, now, hint }) {
  return ask({
    effort: "high",
    system:
      "You read screenshots (class schedules, syllabi, emails, flyers, chat messages, tickets, other calendars) " +
      "and extract every calendar-worthy event. Resolve relative dates ('next Tuesday', 'tomorrow') against the given current date. " +
      "If a year is missing, pick the next occurrence on or after today. Weekly class timetables become one event per class " +
      "with a weekly RRULE; if the term end date is visible, set UNTIL. Assignment/exam deadlines without a time become all-day events " +
      "whose title starts with 'Due:' or 'Exam:'. Never invent events that are not in the image.",
    content: [
      { type: "image", source: { type: "base64", media_type: mediaType, data: base64 } },
      { type: "text", text: `Current local date/time: ${now} (${timezone}).${hint ? `\nUser note: ${hint}` : ""}\nExtract the events.` },
    ],
    schema: ExtractedEvents,
  });
}

// ---------- 2. Categorise events so we can learn routines ----------
export const CATEGORIES = ["class", "study", "exam_or_deadline", "work", "exercise", "social", "meal", "commute", "appointment", "sleep", "other"];
const Categorised = z.object({
  items: z.array(z.object({ id: z.string(), category: z.enum(CATEGORIES) })),
});

export async function categoriseEvents(events) {
  if (!events.length) return [];
  const lines = events.map((e) => `${e.gcal_id}\t${e.summary}${e.location ? ` @ ${e.location}` : ""}`).join("\n");
  const out = await ask({
    effort: "low",
    system: "Classify each calendar event of a student into one category. Return one item per input id.",
    content: `Categories: ${CATEGORIES.join(", ")}\n\nid\ttitle\n${lines}`,
    schema: Categorised,
  });
  return out.items;
}

// ---------- 3. Pick and explain study sessions ----------
const Plan = z.object({
  sessions: z.array(z.object({
    candidate: z.number().int().describe("Index of the chosen candidate slot"),
    subject: z.string().describe("What to study in this session"),
    reason: z.string().describe("One short sentence, addressed to the user, on why this time fits them"),
  })),
  summary: z.string().describe("2-3 sentences on the overall plan for the user"),
});

export async function planStudy({ candidates, profileText, upcoming, goals, subjects, maxPerDay, now, timezone }) {
  const cand = candidates.map((c, i) =>
    `${i}\t${c.label}\tscore=${c.score.toFixed(2)}\t${c.why.join("; ")}`).join("\n");
  const up = upcoming.map((e) => `${e.when}\t${e.summary}${e.category ? ` [${e.category}]` : ""}`).join("\n");
  return ask({
    effort: "medium",
    system:
      "You are a study planner inside a calendar app. You get pre-computed free time slots (already conflict-free, scored " +
      "by the user's learned habits: higher score = times they actually study / are at study places, lower = times they're usually busy). " +
      "Choose the best slots and assign a subject to each. Prioritise subjects with upcoming exams or deadlines, schedule them before " +
      "the deadline with spaced repetition, avoid the night before an early class, and never pick overlapping candidates. " +
      `At most ${maxPerDay} sessions per day. Prefer higher scores unless deadlines justify otherwise.`,
    content:
      `Now: ${now} (${timezone})\n\nWhat I've learned about the user:\n${profileText}\n\n` +
      `Known subjects: ${subjects.length ? subjects.join(", ") : "(infer from class events)"}\n` +
      `User's goals for this plan: ${goals || "(none given)"}\n\n` +
      `Upcoming calendar (next 14 days):\n${up || "(empty)"}\n\nCandidate slots (index, time, score, signals):\n${cand}`,
    schema: Plan,
  });
}

// ---------- 4. Suggest a name for a learned place ----------
const PlaceGuess = z.object({ name: z.string(), kind: z.enum(["home", "school", "library", "work", "gym", "cafe", "social", "other"]) });

export async function guessPlace({ overlappingEvents, hours }) {
  return ask({
    effort: "low",
    system: "Guess what a frequently visited place is from the calendar events that happened while the user was there and the hours they are usually there.",
    content: `Events overlapping visits: ${overlappingEvents.join(" | ") || "(none)"}\nTypical presence: ${hours}`,
    schema: PlaceGuess,
  });
}
