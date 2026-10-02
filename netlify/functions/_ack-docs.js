/**
 * _ack-docs.js — SHARED (leading underscore: NOT an endpoint).
 * ---------------------------------------------------------------------------
 * THE two acknowledgment documents, one per audience, as versioned constants.
 * This module is the single source of truth for the text a portal shows and
 * the hash it logs. docs/legal/*.md are human-readable MIRRORS of these strings
 * (tests/ack-docs.test.js fails if they drift). Change the text here, bump the
 * version, regenerate the mirror. Byte-identical copies live in
 * remote-insight-os/netlify/functions, remote-insight-os/profile-api and the
 * rios-profile-api repo; a version bump lands in all three.
 *
 * ***  DRAFT — pending legal review (Mexico LFT for VA-facing)  ***
 * 2026-10-02: the placeholder wording was replaced by the two counsel-bound
 * drafts (RIOS Virtual Assistant Portal Agreement; RIOS Client Portal
 * Agreement). They are still drafts: every version string below ends in
 * `-draft` until legal signs off, and a portal shows the draft banner while
 * it does. The Privacy Notice link is a visible TODO on purpose.
 *
 * The text is rendered as plain text (white-space: pre-wrap) by both portals,
 * so sections are numbered lines and bullets are "•", never markdown marks.
 * The wording is legal language supplied by Cody, kept verbatim apart from that
 * formatting; the plain-words rule for product copy does not apply to it.
 * They/them throughout; the drafts address the reader as "you".
 *
 * A version bump changes the sha, so everyone who accepted the previous
 * version is asked again (ack-status compares version AND sha; ack-accept
 * refuses a stale pair; the admin panel marks old rows not current).
 */

const crypto = require("node:crypto");

const DOCS = {
  va: {
    version: "2026-10-02-draft",
    title: "RIOS Virtual Assistant Portal Agreement and Acknowledgment",
    text: [
      "PLACEHOLDER — pending legal review (Mexico LFT for VA-facing).",
      "",
      "By selecting \"I agree,\" you acknowledge that you have read and agree to this agreement.",
      "",
      "1. Relationship to services agreement",
      "",
      "Your services relationship with Tele-Help-Ing is governed by the separate services agreement between you and the applicable Tele-Help-Ing entity. This agreement covers your access to and use of RIOS (Remote Insight OS).",
      "",
      "The parties intend for the services relationship to be the independent-contractor relationship described in the applicable services agreement. This acknowledgment does not amend that agreement or waive rights that cannot legally be waived. The nature of any working relationship is determined under applicable law and the facts of the relationship.",
      "",
      "2. Data collection, monitoring, and analysis",
      "",
      "RIOS is designed to capture, track, analyze, and predict patterns in work-related activity and service outcomes. Depending on the features in use, RIOS and related systems may collect or process:",
      "",
      "• Profile information, including legal name, date of birth, contact details, physical address, and emergency contact information.",
      "• Payment and tax-related information needed to process payments or maintain business records, including bank details such as CLABE and applicable tax information. Payment information is encrypted in storage.",
      "• Survey responses, portal activity, and messages with Tele-Help-Ing.",
      "• Time-tracking records collected through Time Doctor.",
      "• Meeting and call information, including recordings, transcripts, or summaries where those features are enabled through Fireflies or another disclosed service.",
      "• Work-related activity, feedback, and service outcomes.",
      "",
      "These systems may use automated tools and human review to identify trends and generate work-related indicators, assessments, scores, or predictions about matters such as communication, responsiveness, engagement, work patterns, and likely service outcomes.",
      "",
      "Tele-Help-Ing uses information linked to you to operate and support the services relationship, review service delivery, identify issues, provide support, prepare internal assessments, and improve its operations. Authorized Tele-Help-Ing personnel may review relevant information. RIOS outputs may be used to guide internal review, support conversations, and service-related recommendations.",
      "",
      "Messages you send through RIOS to Tele-Help-Ing are visible to authorized team members and are not private or confidential communications.",
      "",
      "3. Use and sale of aggregated or de-identified information",
      "",
      "Information linked to you—including an assessment, score, inference, or prediction about you—is treated as personal information where applicable law so provides. This agreement does not authorize Tele-Help-Ing to sell or license your identifiable personal information, or individual-level information linked to you, for third parties' independent use.",
      "",
      "Tele-Help-Ing may create aggregated or de-identified information from RIOS data. If the information is processed so that it does not identify you and cannot reasonably be used to re-identify you, Tele-Help-Ing may use, disclose, license, or sell that information for lawful business purposes, including analytics, benchmarking, research, marketing, product and service development, and training or improving analytical systems and models. Tele-Help-Ing will not knowingly include your name, contact details, account identifiers, or individual-level assessment or prediction in information commercialized under this paragraph.",
      "",
      "4. Privacy notice and data rights",
      "",
      "The collection and use of personal information are also governed by Tele-Help-Ing's Privacy Notice: [TODO: link to current Privacy Notice].",
      "",
      "The Privacy Notice provides additional details about the responsible entity, information collected, purposes of processing, service providers and transfers, retention, and how to exercise applicable privacy rights. Contact hello@telehelping.com with questions or requests concerning your personal information.",
      "",
      "By selecting \"I agree,\" you acknowledge that the Privacy Notice has been made available to you. Where applicable law requires separate or express consent for a particular type of processing, Tele-Help-Ing will request and record that consent as required by law.",
      "",
      "5. Third-party service providers",
      "",
      "RIOS may rely on third-party service providers to host or operate features such as messaging, time tracking, meeting transcription, analytics, or data storage. Those providers may process information on Tele-Help-Ing's behalf, subject to applicable agreements and the Privacy Notice.",
      "",
      "6. Acceptable use",
      "",
      "You may use RIOS only for authorized activities related to your services and your relationship with Tele-Help-Ing. You agree not to:",
      "",
      "• Share your login credentials or allow another person to use your account.",
      "• Access or attempt to access another person's account or information without authorization.",
      "• Interfere with RIOS, bypass security controls, introduce malicious code, or attempt to copy, scrape, reverse engineer, or disrupt the system.",
      "• Upload or share information you are not authorized to disclose, or use the portal to violate another person's privacy or rights.",
      "• Use RIOS to send unlawful, threatening, harassing, or abusive content.",
      "",
      "Report suspected unauthorized access or a security issue to hello@telehelping.com. Tele-Help-Ing may restrict or suspend access when it reasonably believes these rules have been violated, subject to the applicable services agreement and law.",
      "",
      "7. Changes and acceptance",
      "",
      "This agreement is versioned. If Tele-Help-Ing makes a material update, you may be asked to review and accept the updated version before continuing to use RIOS. Your acceptance will be recorded electronically with the applicable version and timestamp.",
      "",
      "By selecting \"I agree,\" you confirm that you have reviewed this agreement and acknowledge that the Privacy Notice has been made available to you.",
    ].join("\n"),
  },
  client: {
    version: "2026-10-02-draft",
    title: "RIOS Client Portal Agreement and Acknowledgment",
    text: [
      "PLACEHOLDER — pending legal review.",
      "",
      "By selecting \"I agree,\" you acknowledge that you have read and agree to this agreement.",
      "",
      "1. Portal access",
      "",
      "RIOS (Remote Insight OS) provides clients with access to certain information and communication features relating to services provided by Tele-Help-Ing. Access is provided for your organization's internal business use and is subject to your agreement with Tele-Help-Ing.",
      "",
      "2. Internal assessments and analytics",
      "",
      "Any performance summary, score, observation, or other assessment available through RIOS reflects Tele-Help-Ing's internal assessment based on information available to it at the time. It is provided as guidance to support communication and service management. It is not a guarantee of any particular performance, outcome, business result, or future service level. It may not reflect every relevant circumstance. You remain responsible for your business decisions and for raising questions or concerns with Tele-Help-Ing.",
      "",
      "RIOS may capture and analyze portal activity, client feedback, service information, and outcomes to operate the portal, support the services relationship, prepare internal assessments, identify trends, and improve Tele-Help-Ing's operations. It may generate aggregated analytics or predictions about service patterns and outcomes.",
      "",
      "3. Confidentiality and permitted use",
      "",
      "RIOS assessments and other nonpublic information about a virtual assistant or Tele-Help-Ing are confidential. You may use this information only for your organization's internal evaluation and management of the services provided by Tele-Help-Ing.",
      "",
      "You may share the information only with people in your organization who need it for that purpose and who are subject to confidentiality obligations. You may not publish, distribute, or disclose it to other people or organizations without Tele-Help-Ing's written permission, except where disclosure is required by law.",
      "",
      "4. Client information and messages",
      "",
      "Tele-Help-Ing may collect and use your name, business email address, company information, account activity, and messages sent through RIOS to provide and administer portal access, respond to requests, support the services relationship, maintain business records, and improve its operations.",
      "",
      "Messages sent through RIOS are stored and may be viewed by authorized Tele-Help-Ing team members. Do not use the portal to send information you do not want Tele-Help-Ing's authorized team to access.",
      "",
      "Additional details are available in the Tele-Help-Ing Privacy Notice: [TODO: link to current Privacy Notice].",
      "",
      "5. Use and sale of aggregated or de-identified information",
      "",
      "Tele-Help-Ing may use, disclose, license, or sell aggregated or de-identified information for lawful business purposes, including analytics, benchmarking, research, marketing, product and service development, and training or improving analytical systems and models, provided the information does not identify you, your company, or another individual and cannot reasonably be used to re-identify them.",
      "",
      "This section does not authorize Tele-Help-Ing to sell your identifiable personal information or portal messages for a third party's independent use.",
      "",
      "6. Acceptable use and account security",
      "",
      "You may use RIOS only for your organization's authorized business purposes related to its services relationship with Tele-Help-Ing. You agree not to:",
      "",
      "• Share account credentials with anyone who is not authorized to access the account.",
      "• Access or attempt to access another user's account, data, or restricted parts of RIOS without authorization.",
      "• Copy, scrape, reverse engineer, interfere with, or attempt to bypass security controls in RIOS.",
      "• Upload malicious code or use the portal in a way that disrupts its operation.",
      "• Use or disclose information available through RIOS in violation of this agreement, the Privacy Notice, or another person's rights.",
      "• Use RIOS to send unlawful, threatening, harassing, or abusive content.",
      "",
      "You are responsible for keeping your account credentials secure and for activity under your account. Report suspected unauthorized access or a security issue to hello@telehelping.com. Tele-Help-Ing may restrict or suspend access when it reasonably believes these rules have been violated, subject to the applicable services agreement and law.",
      "",
      "7. Availability and liability",
      "",
      "RIOS and its assessments are provided for business use. Tele-Help-Ing will use reasonable efforts to maintain access to the portal, but does not guarantee uninterrupted or error-free availability.",
      "",
      "To the extent permitted by applicable law, Tele-Help-Ing is not responsible for indirect, incidental, special, consequential, or punitive damages arising from use of or inability to use RIOS, or from decisions made based on an internal assessment displayed in the portal. Nothing in this agreement excludes liability that cannot legally be excluded. Any additional limits of liability in your services agreement also apply.",
      "",
      "8. Governing terms and updates",
      "",
      "Your services agreement with Tele-Help-Ing governs the services relationship. This agreement governs access to and use of RIOS. Any governing-law or dispute-resolution terms in your services agreement apply unless counsel-approved portal terms specify otherwise.",
      "",
      "This agreement is versioned. If Tele-Help-Ing makes a material update, you may be asked to review and accept the updated version before continuing to use RIOS. Your acceptance will be recorded electronically with the applicable version and timestamp.",
      "",
      "By selecting \"I agree,\" you confirm that you have reviewed and agree to this portal agreement and acknowledge that the Privacy Notice has been made available to you.",
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
    "> **DRAFT — pending legal review" + (audience === "va" ? " (Mexico LFT for VA-facing)" : "") + ".**",
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
