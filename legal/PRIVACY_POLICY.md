# Privacy Policy — Transcriptor MCP (hosted service)

**Version:** 1.0
**Last updated:** August 13, 2026
**Effective date:** August 13, 2026

Companion document: [Terms of Service](./TERMS_OF_SERVICE.md). "Output" has the meaning given to it in section 3 of the Terms.

## 1. Who is responsible

A natural person resident in Spain operates the hosted Transcriptor MCP service at `https://transcriptor.gateway.mcpal.io/mcp` (the "Service") and is the controller for the processing described here. Our postal address and tax identification number (NIF) are available on request. Email: legal@transcriptor-mcp.org. We have not appointed a data protection officer and are not required to.

This policy covers only the hosted Service. If you run the software yourself from <https://github.com/samson-art/transcriptor-mcp>, we are not the controller and we process nothing about you.

## 2. Our role and MCPal's role

We publish the Service on the MCPal platform (`mcpal.io`), which we do not operate. MCPal supplies the gateway that relays your calls, sign-in through its Zitadel identity system, metering and quota enforcement.

MCPal is the controller for the account and identity data in its systems, for the acceptance records and for the per-call usage records in section 3: it shows both documents at sign-in, records your acceptance, and holds and deletes the usage ledger on its own systems and to its own retention rules. Its policy at `https://mcpal.io/privacy.html` covers that layer. We receive those records as a recipient, through the MCPal dashboard, and we are the controller for what our own server does with your request. If you send us a request we cannot answer because the data sits in MCPal's systems, we forward it and tell you we have done so.

The Service is free, so we take no payment and process no payment or billing data about you.

## 3. What is processed

- **Account and identity data**, held by MCPal: internal and Zitadel identifiers, email address, name, organisation identifier, creation and update dates. We never receive your password. The OAuth clients your MCP application registers automatically are stored with your identifier.
- **Acceptance record** (the platform calls it a consent record), held by MCPal: your Zitadel identifier, the server, the version of the Terms and of this policy you accepted, the time, **your IP address and your browser user-agent string**. It exists because both documents are shown on the sign-in screen, where you accept them.
- **Per-call usage records**: one row per tool call in MCPal's ledger, with the server, the tool name, the time, success or failure, the duration, a client reference, your identifier, and technical fields about the call that the gateway sets. These records identify you.
- **What you send and what we return**: the addresses, search terms and other parameters you submit, and the Output we return.

## 4. What happens to your requests

Every tool call travels through the MCPal gateway to our server, so what you submit and the Output pass through both systems. Our server writes temporary files while it works and deletes them as soon as the call ends. If the server stops in the middle of a call, a file can stay until the server restarts and its temporary storage is replaced. We keep no Output. Both systems produce ordinary operational logs, so we do not promise that nothing about a request is written down.

Response caching and the optional Whisper audio transcription are switched off on the hosted Service, so it downloads no audio and stores no transcript. If we switch either on, we will update this policy first and state the storage period.

If that optional transcription is switched on, our server keeps in memory the addresses of up to the last 100 subtitle requests that failed, with the time of failure, so that we can diagnose faults. It is off on the hosted Service, so the list stays empty. The list is in memory only, it is lost when the server restarts, and no endpoint returns it: the hosted server answers only a health check, a metrics endpoint that reports counts and timings, and the MCP endpoint.

We use nothing you send or receive to train any model, and we allow no provider to do so. We do no advertising, profiling or marketing.

## 5. Purposes and legal bases

- Give you access, run your calls and apply the daily free quota: performance of our contract, Article 6(1)(b) GDPR.
- Record the version you accepted, with IP address and user-agent string: our legitimate interest in proving the documents were shown and accepted, Article 6(1)(f). This is your acceptance of the documents, not consent under Article 6(1)(a).
- Keep the Service working, diagnose faults, prevent abuse and quota circumvention: our legitimate interest in a secure and reliable service, Article 6(1)(f).

You may object to legitimate-interest processing at any time under Article 21 GDPR. We rely on consent for nothing described here, so there is no consent to withdraw. Our MCP endpoint accepts POST requests only and sets no cookies; any cookies at sign-in belong to MCPal.

## 6. Who receives data

MCPal (gateway, identity, metering), Zitadel (identity, used by MCPal), Supabase (the database holding the platform data in section 3), and the companies that host the MCPal gateway and our server. The hosting companies process every request and every Output in transit.

The Output goes back to the MCP client you connected, so the company that operates that client and its AI model receives it. That company is a separate controller under its own policy, we do not choose it, and we cannot control what it keeps. Consider this before you request material about identifiable people.

Our server is able to send fault reports to Sentry (Functional Software, Inc.), and you should assume that it does. A report holds the error, the tool name, the submitted address and the log lines before it in that request, which can include the command we ran and the source platform's error output. We do not enable Sentry's optional collection of IP addresses and request headers, and we send Sentry no request or response bodies.

Sentry and a hosting company may process data outside the European Economic Area, including in the United States. Where they do, the transfer is covered by the European Commission's standard contractual clauses or, where the recipient is certified, by the EU–US Data Privacy Framework. Ask us for the safeguards that apply to a given recipient and for the country its servers are in.

Our server requests captions, metadata and frames from the source platform over our own network connection. We send that platform no identifier of yours and never use your credentials. We do not sell personal data, do not share it for advertising, and disclose it to an authority only where the law requires it.

## 7. How long data is kept

- **Output**: not kept beyond the call. Temporary files are deleted at the end of the call, and at the latest when the server restarts.
- **Failed-request list**: in memory only, empty while optional transcription is off, replaced after 100 entries, lost on restart.
- **Usage records that identify you**: 45 days, then deleted automatically. Before deletion they are rolled up into daily totals per server and per tool and into counts of distinct users per day, week and month. Those totals carry no identifier and are kept for the life of the Service.
- **Account and identity records**: kept by MCPal while your account exists, for the periods in its policy.
- **Acceptance records, including the IP address and user-agent string captured at sign-in**: held by MCPal while your account exists and deleted with it, for the periods in its policy.
- **Fault reports at Sentry**: no more than 90 days.
- **Operational logs on our server**: no more than 30 days, then overwritten. MCPal's gateway logs follow the periods in its policy.
- **Backups**: overwritten on a rolling cycle of no more than 35 days.

## 8. Your rights

You may ask for access to all personal data we hold about you, and for correction, erasure or restriction. You may also ask for a portable copy of the data you gave us, and you may object to legitimate-interest processing. Write to legal@transcriptor-mcp.org. We answer within one month, and may extend by two months for a complex request if we tell you inside the first month. We may ask for information to confirm the request is yours, because a user identifier is often the only information linking data to you. Identity and acceptance records sit in systems MCPal operates: we act on what we control and forward the rest.

You may complain to the Spanish supervisory authority, the Agencia Española de Protección de Datos (AEPD), C/ Jorge Juan 6, 28001 Madrid, `www.aepd.es`, which supervises us because we are established in Spain. You may also complain to the authority where you live or work.

## 9. Providing data, and automated decisions

An MCPal account and sign-in are needed to use the Service; without them we cannot provide it. Quota, entitlement and abuse checks run automatically and decide only whether one request is allowed. A decision to suspend or end your access is taken by a person, not automatically. We take no automated decision producing a legal effect for you or similarly significantly affecting you.

## 10. People who appear in videos

Subtitles, metadata and frames can contain personal data about people who speak or appear in a video. We process it on our legitimate interest in producing the result the user asked for, Article 6(1)(f) GDPR. The data comes from the video at the address a user submits, on the platform hosting it, which our server reads at the moment of the request. It can include a voice as transcribed, a name and other details in the description or metadata, and an image in a single still frame. It goes to the user who asked and to that user's MCP client. We keep no copy (section 7).

Where a video published by the person concerned contains special category data, we rely on Article 9(2)(e) GDPR, data manifestly made public by the data subject. Where such data concerns anyone other than the person who published the video, we have no condition under Article 9 to process it, we do not knowingly process it, and section 8 of the [Terms of Service](./TERMS_OF_SERVICE.md) forbids users to use the Service for that purpose. If you tell us that an address exposes special category data about you, we block that address.

We hold no contact details for the people who appear in videos, so we cannot notify them individually. Article 14(5)(b) GDPR allows this where notice would take disproportionate effort, so we publish this policy instead, at the address in section 12. If you appear in a video, you have the rights in section 8, you may object by writing to legal@transcriptor-mcp.org, and you may complain to the AEPD.

## 11. Children and security

The Service is not directed at children and we do not knowingly process their data; the minimum age is in the [Terms of Service](./TERMS_OF_SERVICE.md).

Traffic is encrypted in transit and access to our systems is restricted. We hold no security certification, and no online service can be guaranteed secure. Where a personal data breach occurs we notify the AEPD within 72 hours where Article 33 GDPR requires it, and tell affected users without undue delay where the risk to them is high. Report a security problem to legal@transcriptor-mcp.org.

## 12. Changes and contact

This policy carries a version number, and the acceptance record stores the version you accepted. We give at least 30 days' notice of any change, by email and additionally on the sign-in screen. If you do not accept the new version you may stop using the Service, which costs you nothing; section 18 of the [Terms of Service](./TERMS_OF_SERVICE.md) applies to changes.

The current version is published at <https://github.com/samson-art/transcriptor-mcp/blob/main/legal/PRIVACY_POLICY.md>. Every version stays in that repository's history. This policy and the Terms are published in English.

Controller: the Service operator, Spain. Email: legal@transcriptor-mcp.org. If a message to legal@transcriptor-mcp.org comes back undelivered, ask us for our postal address and write to us there.