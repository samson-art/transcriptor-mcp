# Terms of Service

**Transcriptor MCP Hosted Service**

**Last updated:** May 28, 2026  
**Effective date:** May 28, 2026

---

## 1. Agreement

These Terms of Service (“**Terms**”) govern your access to and use of the hosted **Transcriptor MCP** service (the “**Service**”), including any websites, OAuth authorization flows, API endpoints, MCP transports (`/mcp`, `/sse`, and related routes), and associated infrastructure operated under domains such as `transcriptor.comedy.cat` and successor or mirror hostnames (collectively, the “**Service Endpoints**”).

The Service is operated by **samson-art** (“**we**”, “**us**”, “**our**”, or the “**Operator**”).

By registering an OAuth client, obtaining credentials, connecting an MCP host, or otherwise using the Service, you agree to these Terms and to our [End User License Agreement](./EULA.md) (“**EULA**”). If you do not agree, do not use the Service.

If you use the Service on behalf of an organization, you represent that you have authority to bind that organization, and “you” includes that organization.

---

## 2. Description of the Service

Transcriptor MCP is a remote **Model Context Protocol (MCP)** server that retrieves **textual** video metadata, subtitles, and transcripts from third-party platforms (including YouTube, Twitter/X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion, and Reddit) using tools such as `yt-dlp`, and may optionally transcribe audio via Whisper or similar services when subtitles are unavailable.

The Service is intended to return **text and metadata only**. It is **not** designed or offered for downloading, storing, or redistributing video or audio files.

The open-source software in the [transcriptor-mcp repository](https://github.com/samson-art/transcriptor-mcp) is licensed separately under the MIT License. These Terms apply only to the **hosted Service**, not to self-hosted deployments you run yourself.

---

## 3. Eligibility

You must be at least **18 years old** (or the age of legal majority in your jurisdiction) and capable of entering a binding contract.

You may not use the Service if you are barred from doing so under applicable law or if we have previously suspended or terminated your access.

---

## 4. Accounts, OAuth, and Credentials

### 4.1 Registration

Access to the hosted Service may require **OAuth 2.1** authentication, including dynamic client registration and issuance of access tokens, or legacy token mechanisms where still supported.

You are responsible for:

- the accuracy of information you provide during registration or authorization;
- maintaining the confidentiality of client secrets, refresh tokens, access tokens, API tokens, and any other credentials;
- all activity conducted with your credentials, whether authorized by you or not.

Notify us promptly at [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues) if you believe your credentials have been compromised.

### 4.2 No Sharing or Resale

Unless we expressly authorize otherwise in writing, you may not sell, sublicense, share, or publicly redistribute access to the hosted Service or your credentials.

---

## 5. Acceptable Use

You agree to use the Service only for lawful purposes and in compliance with these Terms, the EULA, and all applicable laws and regulations.

**You must not:**

1. use the Service to infringe intellectual property, privacy, publicity, or other rights of any person or entity;
2. use the Service to access, extract, or redistribute content in violation of the terms, robots rules, or policies of any third-party platform whose URLs you submit;
3. circumvent rate limits, quotas, authentication, or technical access controls;
4. probe, scan, or test the vulnerability of the Service or related systems without our prior written consent;
5. introduce malware, perform denial-of-service attacks, or otherwise interfere with the Service or its users;
6. use the Service for spam, fraud, harassment, or illegal surveillance;
7. use the Service to build a competing hosted transcript service by systematically mirroring our infrastructure or outputs without authorization;
8. submit URLs or requests relating to child sexual abuse material (CSAM), terrorism, or other unlawful content;
9. misrepresent your identity or affiliation;
10. use the Service in any manner that could expose us to liability or harm third parties.

We may investigate violations and cooperate with law enforcement where required or appropriate.

---

## 6. Third-Party Platforms and Content

### 6.1 No Affiliation

We are **not** affiliated with, endorsed by, or sponsored by YouTube, Google, Meta, Twitter/X, TikTok, Twitch, or any other third-party platform. All trademarks belong to their respective owners.

### 6.2 Your Responsibility

When you submit a URL or identifier to the Service, you represent that:

- you have a lawful basis to request the associated metadata or transcript;
- your use of any returned content complies with applicable copyright law and the platform’s terms of use;
- you will not use the Service to reproduce, distribute, or create derivative works from third-party content except as permitted by law or platform policy.

The Service retrieves information **from public or accessible sources** as interpreted by third-party tools. We do not guarantee that any particular video, transcript, or metadata item is available, accurate, complete, or lawful to use.

### 6.3 Copyright Complaints

If you believe content processed through the Service infringes your copyright, contact us via [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues) with:

- identification of the copyrighted work;
- the URL or material at issue;
- your contact information;
- a statement of good-faith belief and accuracy under penalty of perjury (where applicable).

We may disable access to specific functionality or suspend accounts in response to valid complaints or legal requests.

---

## 7. Quotas, Availability, and Changes

### 7.1 Quotas and Rate Limits

The Service may enforce per-client, per-token, or per-IP quotas and rate limits (including via API gateway policies). Exceeding limits may result in throttling, temporary blocks, or termination.

We may change limits at any time with or without notice.

### 7.2 Availability

The Service is provided on an **as-available** basis. We do not guarantee uninterrupted, error-free, or secure operation. Maintenance, upstream platform changes, network issues, or third-party outages may cause failures or degraded performance.

### 7.3 Modifications

We may modify, suspend, or discontinue any part of the Service at any time. We may update these Terms by posting a revised version in this repository and updating the “Last updated” date. Material changes may additionally be communicated through the authorization gateway or Service Endpoints where practicable.

Continued use after changes become effective constitutes acceptance of the revised Terms.

---

## 8. Fees

The hosted Service may be offered free of charge or with usage limits. If we introduce paid plans in the future, additional payment terms will apply. We reserve the right to change pricing or introduce charges with reasonable notice where required by law.

---

## 9. Privacy

We process limited technical data necessary to operate the Service (such as OAuth client identifiers, request metadata, IP addresses, timestamps, and usage counters for quotas).

We do not intentionally persist full transcript text beyond what is required for caching, debugging, or legal compliance, but transient processing and logs may occur. Do not submit sensitive personal data unless necessary and lawful.

A separate Privacy Policy may be published later. Until then, contact us with privacy questions via [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues).

---

## 10. Suspension and Termination

We may suspend or terminate your access immediately, with or without notice, if we reasonably believe you have violated these Terms, pose a security risk, or if required by law.

Upon termination, your right to use the Service ends. Sections that by nature should survive (including disclaimers, limitation of liability, indemnification, and governing law) will survive.

You may stop using the Service at any time by revoking OAuth tokens and deleting registered clients where your authorization server allows.

---

## 11. Disclaimers

**TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE” WITHOUT WARRANTIES OF ANY KIND, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE.**

We disclaim all warranties, including implied warranties of **merchantability**, **fitness for a particular purpose**, **title**, **non-infringement**, and **accuracy**.

Without limiting the foregoing, we do not warrant that:

- transcripts, subtitles, or metadata are accurate, complete, or up to date;
- the Service will meet your requirements or integrate with your MCP client;
- third-party platforms will remain accessible;
- the Service is free from defects, viruses, or harmful components.

Some jurisdictions do not allow certain disclaimers; in those jurisdictions, disclaimers apply to the fullest extent permitted.

---

## 12. Limitation of Liability

**TO THE MAXIMUM EXTENT PERMITTED BY LAW:**

1. **NO INDIRECT DAMAGES.** We shall not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or for loss of profits, revenue, data, goodwill, or business interruption, arising from or related to the Service or these Terms, even if we have been advised of the possibility.

2. **LIABILITY CAP.** Our total aggregate liability for all claims arising from or related to the Service or these Terms shall not exceed the greater of **(a) USD $100** or **(b) the amounts you paid us for the Service in the twelve (12) months before the event giving rise to the claim** (which may be zero if the Service is free).

3. **ESSENTIAL PURPOSE.** These limitations apply regardless of the theory of liability (contract, tort, negligence, strict liability, or otherwise) and even if any remedy fails of its essential purpose.

Some jurisdictions do not allow limitation of certain damages; in those jurisdictions, our liability is limited to the fullest extent permitted by law.

---

## 13. Indemnification

You agree to **defend, indemnify, and hold harmless** the Operator and its affiliates, contributors, and service providers from and against any claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys’ fees) arising from or related to:

- your use of the Service;
- content or URLs you submit;
- your violation of these Terms, the EULA, or applicable law;
- your violation of any third-party rights, including intellectual property or platform terms.

We may assume exclusive defense and control of any matter subject to indemnification; you agree to cooperate.

---

## 14. Governing Law and Disputes

These Terms are governed by the laws of the **jurisdiction in which the Operator is established**, without regard to conflict-of-law principles, except where mandatory consumer protection laws of your country of residence apply.

Any dispute arising from these Terms or the Service shall be resolved exclusively in the courts of that jurisdiction, unless applicable law requires otherwise.

You and we waive any right to participate in a class action or class-wide arbitration to the extent such waiver is enforceable.

---

## 15. General

- **Entire agreement.** These Terms together with the EULA constitute the entire agreement regarding the hosted Service.
- **Severability.** If any provision is unenforceable, the remainder remains in effect.
- **No waiver.** Failure to enforce a provision is not a waiver.
- **Assignment.** You may not assign these Terms without our consent. We may assign them in connection with a merger, acquisition, or sale of assets.
- **Force majeure.** We are not liable for delays or failures due to events beyond our reasonable control.
- **Language.** The English version of these Terms controls. Translations are for convenience only.

---

## 16. Contact

**Operator:** samson-art  
**Project:** [github.com/samson-art/transcriptor-mcp](https://github.com/samson-art/transcriptor-mcp)  
**Contact:** [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues)
