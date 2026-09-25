/**
 * _ack-docs.js — SHARED (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * THE two acknowledgment documents, one per audience, as versioned constants.
 * This module is the single source of truth for the text a portal shows and
 * the hash it logs. docs/legal/*.md are human-readable MIRRORS of these strings
 * (tests/ack-docs.test.js fails if they drift). Change the text here, bump the
 * version, regenerate the mirror.
 *
 * ***  PLACEHOLDER — pending legal review (Mexico LFT for VA-facing)  ***
 * The mechanism is real; the wording is not final. Every version string below
 * ends in `-draft` until legal signs off; a portal will show the draft banner
 * while it does.
 *
 * Plain, common words. They/them. Benefit-framed. Never the words monitor,
 * surveillance, recorded, compliance in anything a VA or client reads.
 */

const crypto = require("node:crypto");

const DOCS = {
  va: {
    version: "2026-09-24-draft",
    title: "Before you start — how RIOS works for you",
    text: [
      "PLACEHOLDER — pending legal review (Mexico LFT for VA-facing).",
      "",
      "RIOS is where your team keeps track of how work is going, so they can coach you well and speak up for you with clients.",
      "",
      "A few things to know, once, before you go in:",
      "",
      "• Your work is scored. Check-in calls, your survey answers, and messages in Team chat all feed a read of the five qualities: productive, responsive, professional, skilled, happy. It is a read, not a verdict, and your manager sees the full picture before anything is acted on.",
      "",
      "• Your activity here is visible to your team. When you sign in, which parts of RIOS you use, and when you open a document your team shared — your team can see that. This helps them know what reached you.",
      "",
      "• Chat is visible to your team. Anything you write in Team chat, or in a chat with a client, can be read by your manager. Nothing here is hidden.",
      "",
      "• Personal matters stay personal. If you tell your team about money, health, family, or anything else outside the work, it never reaches a client.",
      "",
      "You can ask your manager about any of this at any time.",
    ].join("\n"),
  },
  client: {
    version: "2026-09-24-draft",
    title: "Before you start — a few things to know",
    text: [
      "PLACEHOLDER — pending legal review.",
      "",
      "This portal gives you a plain-language read on the people who work with you, and simple ways to reach them.",
      "",
      "A few things to know, once:",
      "",
      "• We keep track of how the portal is used. When you sign in and which parts you use — so we can make it more useful and make sure things reach you.",
      "",
      "• Chat is not private between you and your VA. Anything written in a chat with your VA, or with the Tele-Help-Ing team, can be read by the team. That is on purpose: it helps us build and coach a better VA for you.",
      "",
      "• Keep it about the work. If you'd rather talk about something else, email us.",
      "",
      "You never have to use chat; it is one way to reach us among others.",
    ].join("\n"),
  },
};

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

const AUDIENCES = Object.keys(DOCS);

/** current(audience) -> { audience, version, title, text, sha256, draft } | null */
function current(audience) {
  const d = DOCS[audience];
  if (!d) return null;
  return {
    audience,
    version: d.version,
    title: d.title,
    text: d.text,
    sha256: sha256(d.text),
    draft: /-draft$/.test(d.version),
  };
}

/** Render the markdown mirror for docs/legal/<audience>-acknowledgment.md */
function mirrorMarkdown(audience) {
  const d = current(audience);
  if (!d) return "";
  return [
    `# ${d.title}`,
    "",
    `**Audience:** ${audience}  `,
    `**Version:** \`${d.version}\`  `,
    `**sha256:** \`${d.sha256}\``,
    "",
    "> **PLACEHOLDER — pending legal review" + (audience === "va" ? " (Mexico LFT for VA-facing)" : "") + ".**",
    "> This file is a generated mirror of `netlify/functions/_ack-docs.js`. Edit the",
    "> module, bump the version, and regenerate — never edit this file by hand.",
    "",
    "---",
    "",
    d.text,
    "",
  ].join("\n");
}

module.exports = { DOCS, AUDIENCES, sha256, current, mirrorMarkdown };
