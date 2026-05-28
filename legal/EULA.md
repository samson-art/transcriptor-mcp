# End User License Agreement (EULA)

**Transcriptor MCP Hosted Service**

**Last updated:** May 28, 2026  
**Effective date:** May 28, 2026

---

## 1. Parties and Acceptance

This End User License Agreement (“**Agreement**” or “**EULA**”) is a legal agreement between **samson-art** (“**Licensor**”, “**we**”, “**us**”, or “**our**”) and you (“**Licensee**”, “**you**”, or “**your**”).

It governs your access to and use of the hosted **Transcriptor MCP** software service (the “**Licensed Service**”), including MCP tools, HTTP/SSE endpoints, OAuth-protected resources, and related components made available at Service Endpoints such as `transcriptor.comedy.cat`.

**By clicking “Accept”, completing OAuth authorization, registering a client, obtaining an access token, or using the Licensed Service, you agree to this EULA and our [Terms of Service](./TERMS_OF_SERVICE.md).** If you do not agree, do not access or use the Licensed Service.

This EULA applies to the **hosted** offering only. The open-source project at [github.com/samson-art/transcriptor-mcp](https://github.com/samson-art/transcriptor-mcp) remains licensed under the **MIT License** for source code you download, modify, and self-host. Self-hosted instances are not covered by this EULA unless we explicitly agree otherwise in writing.

---

## 2. Definitions

- **“Client Application”** — your MCP host, IDE plugin, agent, script, or other software that connects to the Licensed Service.
- **“Credentials”** — OAuth client IDs, client secrets, access tokens, refresh tokens, API tokens, and similar authentication material.
- **“Output”** — transcripts, subtitles, metadata, chapters, search results, and other data returned by the Licensed Service.
- **“Service Endpoints”** — URLs operated by Licensor for the Licensed Service, including MCP, SSE, OAuth metadata, and registration routes.

---

## 3. License Grant

Subject to your compliance with this EULA and the Terms of Service, Licensor grants you a **limited, non-exclusive, non-transferable, non-sublicensable, revocable** license to:

1. access and use the Licensed Service through supported MCP and HTTP interfaces;
2. integrate the Licensed Service with your Client Application for your internal or personal lawful purposes;
3. use Output solely in compliance with applicable law and third-party platform terms.

No ownership of the Licensed Service, its underlying software, documentation, or branding is transferred to you.

---

## 4. License Restrictions

Except as expressly permitted by applicable law or our written authorization, you **shall not**:

1. copy, modify, adapt, translate, or create derivative works of the Licensed Service or its server-side components;
2. reverse engineer, decompile, disassemble, or attempt to derive source code from the hosted Licensed Service (note: open-source components remain available under their respective licenses in the public repository);
3. rent, lease, lend, sell, sublicense, or otherwise commercialize access to the Licensed Service or Credentials;
4. remove, obscure, or alter proprietary notices;
5. use the Licensed Service to develop a substantially similar competing hosted service by automated extraction of our implementation, configuration, or operational patterns;
6. use the Licensed Service in violation of export control, sanctions, or anti-corruption laws;
7. use the Licensed Service in safety-critical, medical, legal, financial, or other high-risk contexts where inaccurate Output could cause death, personal injury, or significant harm;
8. exceed applicable quotas, bypass technical controls, or use shared Credentials across unrelated users or organizations without authorization.

---

## 5. Credentials and Security

Credentials are issued for your use only. You must:

- store Credentials securely;
- not embed Credentials in public repositories, client-side bundles, or shared logs;
- rotate or revoke Credentials if compromise is suspected;
- ensure your Client Application does not expose Credentials to end users unless each end user has accepted this EULA and Terms of Service.

You are fully responsible for all API and MCP activity performed with your Credentials.

---

## 6. Third-Party Software and Platforms

The Licensed Service incorporates or interacts with third-party open-source and commercial components (including but not limited to `yt-dlp`, `ffmpeg`, Whisper runtimes, OAuth identity providers, and cloud infrastructure).

Third-party components may be subject to separate licenses. Platform operators may change APIs, block access, or assert rights independently of Licensor.

**Licensor is not responsible for third-party software, platforms, or services**, including their availability, policies, or enforcement actions against you.

---

## 7. Output and Intellectual Property

### 7.1 Licensor IP

The Licensed Service, its name **Transcriptor MCP**, logos, documentation, and all related intellectual property (excluding third-party and open-source components) are owned by Licensor or its licensors.

### 7.2 Third-Party Content in Output

Output may contain text and metadata originating from third-party platforms and copyright holders. **Licensor grants no rights in such third-party content.** You are solely responsible for determining whether your use of Output is permitted.

### 7.3 Feedback

If you provide suggestions or feedback, you grant Licensor a perpetual, irrevocable, royalty-free license to use it without restriction or compensation.

---

## 8. Updates

Licensor may update the Licensed Service, MCP tool schemas, authentication flows, or this EULA at any time. Updated terms will be posted in this repository with a revised “Last updated” date.

Your continued use after the effective date of changes constitutes acceptance. If you do not agree to updated terms, you must stop using the Licensed Service and revoke Credentials.

---

## 9. Support

Unless we offer a separate support agreement, the Licensed Service is provided **without dedicated support**. Community assistance may be available via [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues) at our discretion.

---

## 10. Disclaimer of Warranties

**THE LICENSED SERVICE AND ALL OUTPUT ARE PROVIDED “AS IS” AND “AS AVAILABLE.”**

**LICENSOR DISCLAIMS ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, NON-INFRINGEMENT, AND ACCURACY.**

Without limiting the above:

- Output may be incomplete, outdated, mistranscribed, or unavailable;
- automated transcription (including Whisper) may contain errors;
- platform changes may break tools without notice;
- the Licensed Service may contain bugs or security vulnerabilities.

You assume all risk arising from your use of the Licensed Service and Output.

Some jurisdictions do not allow exclusion of implied warranties; in those jurisdictions, the above exclusions apply to the maximum extent permitted by law.

---

## 11. Limitation of Liability

**TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:**

1. **NO CONSEQUENTIAL DAMAGES.** Licensor shall not be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages, or for lost profits, revenue, data, or business opportunities, arising from this EULA or use of the Licensed Service, even if advised of the possibility.

2. **CAP ON DIRECT DAMAGES.** Licensor’s total cumulative liability for all claims under this EULA shall not exceed the greater of **(a) USD $100** or **(b) amounts paid by you to Licensor for the Licensed Service in the twelve (12) months preceding the claim** (which may be zero).

3. **HIGH-RISK USE.** Licensor specifically disclaims liability for decisions or actions you take based on Output, including AI-generated summaries or analyses produced by your Client Application.

These limitations apply to the fullest extent permitted in your jurisdiction.

---

## 12. Indemnification

You agree to indemnify, defend, and hold harmless Licensor and its contributors, contractors, and affiliates from any claims, damages, liabilities, and expenses (including reasonable legal fees) arising from:

- your use of the Licensed Service or Output;
- your Client Application;
- breach of this EULA or the Terms of Service;
- infringement or violation of third-party rights, including copyright and platform terms.

---

## 13. Term and Termination

This EULA is effective until terminated.

Licensor may terminate or suspend your license immediately if you breach this EULA, the Terms of Service, or if continued access poses legal, security, or operational risk.

Upon termination:

- your license ends immediately;
- you must cease using the Licensed Service and delete Credentials from your systems where feasible;
- Sections intended to survive (including restrictions, disclaimers, limitation of liability, and indemnification) remain in effect.

---

## 14. Export and Sanctions Compliance

You represent that you are not located in, under the control of, or a national or resident of any country or person subject to comprehensive international sanctions, and that you will not use the Licensed Service in violation of export control or sanctions laws.

---

## 15. U.S. Government Users (if applicable)

If you are a U.S. Government entity, the Licensed Service is “commercial computer software” and “commercial computer software documentation” as defined in FAR 12.212 and DFARS 227.7202, licensed with only those rights set forth in this EULA.

---

## 16. Governing Law

This EULA is governed by the laws of the **jurisdiction in which Licensor is established**, excluding conflict-of-law rules, except where mandatory consumer protection laws apply.

Exclusive venue for disputes lies in the courts of that jurisdiction unless otherwise required by applicable law.

---

## 17. Miscellaneous

- **Entire agreement.** This EULA and the Terms of Service are the complete agreement regarding the Licensed Service.
- **Severability.** Invalid provisions do not affect the remainder.
- **No waiver.** Failure to enforce is not a waiver of rights.
- **Assignment.** You may not assign this EULA without consent. Licensor may assign it freely in connection with business transfers.
- **Independent contractors.** The parties are independent contractors; no partnership, agency, or employment relationship is created.

---

## 18. Contact

**Licensor:** samson-art  
**Repository:** [github.com/samson-art/transcriptor-mcp](https://github.com/samson-art/transcriptor-mcp)  
**Contact:** [GitHub Issues](https://github.com/samson-art/transcriptor-mcp/issues)
