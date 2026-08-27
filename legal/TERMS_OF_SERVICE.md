# Terms of Service — Transcriptor MCP

**Last updated:** August 13, 2026
**Effective date:** August 13, 2026
**Version:** 1.0

These Terms replace the End User Licence Agreement published earlier. The licence to use the Service is section 6.

## 1. Provider identity

The Service is provided by a natural person (persona física) resident in Spain ("we", "us").

- Address: Spain; full postal address provided on request via the contact e-mail
- Tax identification number (NIF/NIE): provided on request via the contact e-mail
- Contact e-mail, for direct and effective communication: **legal@transcriptor-mcp.org**

## 2. What these Terms cover

These Terms are a contract between you and us for the hosted Transcriptor MCP service at `https://transcriptor.gateway.mcpal.io/mcp` (the "Service"). They bind you from the moment you accept them by an affirmative act — ticking the acceptance box shown with these Terms and the [Privacy Policy](./PRIVACY_POLICY.md) on the sign-in and consent screen — before your first tool call. We record the version number, the date and time, and that you ticked it.

Sign-in, the gateway and quota metering run on the MCPal platform, which we do not operate. You accept MCPal's terms separately when you sign in.

**Self-hosting is not covered by these Terms.** The source and documentation at <https://github.com/samson-art/transcriptor-mcp> are under the MIT Licence. An instance you run yourself is governed by that licence alone, needs no account and costs nothing. The container image also contains third-party software under other licences, including ffmpeg and yt-dlp, which the MIT Licence does not govern.

Personal data is covered by the [Privacy Policy](./PRIVACY_POLICY.md).

## 3. What the Service is, and is not

You supply a video URL, or a YouTube search term, and the Service returns text, metadata, subtitle files, chapter lists, search results and single still frames (the "Output"). It supports eleven video platforms: YouTube, X (Twitter), Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion and Reddit. Search is YouTube only. A frame is one still image at a timecode you give, up to 1920 pixels wide.

The Service never gives you an audio or video file. Optional audio transcription (Whisper) and the optional response cache are off and are not part of the hosted Service; the [Privacy Policy](./PRIVACY_POLICY.md) explains what that means for your data.

We do not crawl, index, recommend, host or store content for third parties, and we keep no archive or training corpus. You decide what to request and you are responsible for having the right to the result.

## 4. Eligibility and consumer status

You must be at least 18 years old and able to enter a binding contract.

The Service is open to business users and to consumers. If you use it for purposes outside your trade, business, craft or profession, you are a consumer and the paragraphs marked **Consumers** apply to you. That status follows from how you actually use the Service; nothing in these Terms removes it, and no box you tick removes it.

Nothing here excludes or limits any right that mandatory Spanish or EU consumer law gives you. If a term here would do that, it does not apply to you, and the mandatory rule applies instead.

## 5. How access works

Access uses OAuth 2.1 through MCPal. Your MCP client registers itself and you sign in through a browser. You hold no API key, client secret or static token. Keep your sign-in secure. You are responsible for what the clients you authorise do. Do not share a session: each person must sign in with their own account.

## 6. Licence, intellectual property and feedback

While your access lasts, we grant you a limited, non-exclusive, non-transferable, non-sublicensable and revocable licence to connect to the Service with an MCP client, call its tools, and use the Output for your own lawful purposes. The licence is conditional on sections 7 and 8, transfers no ownership, and ends when your access ends.

The Output describes and reproduces material made by other people. **We grant you no rights in that material and give no assurance that your use of it is permitted.**

We keep our rights in the name "Transcriptor MCP" and any logo; neither is licensed under the MIT Licence. You may use the name to state that your product works with the Service, but not to name a fork or a competing service.

If you send us ideas, bug reports or suggestions, we may use them to improve the Service. You keep any rights you have in them.

## 7. What you promise about every URL you submit

For each URL you send, you confirm that:

- **(a)** the content is publicly accessible, without a login, a payment, or a tool that defeats a regional block or an age gate;
- **(b)** you own it, you have the rightsholder's permission, or a legal exception covers your use of the Output;
- **(c)** submitting it breaks no agreement that binds you; and
- **(d)** you are entitled to give us the instruction in section 9 and to authorise the technical copies we must make to carry it out.

**Never send us credentials, cookies, tokens or session data for any platform, and never ask us to use them.** If you do, we may suspend or end your access under section 13.

## 8. Prohibited use

Do not use the Service to:

- reach content behind a login, a paywall, an age gate or a geographic restriction;
- extract a rightsholder's catalogue systematically, or build an archive;
- request frames in sequence to rebuild a video;
- republish Output as a substitute for the source;
- train models on Output where the rightsholder has reserved that use under Article 4(3) of Directive (EU) 2019/790;
- collect data revealing racial or ethnic origin, political opinions, religious or philosophical beliefs, trade union membership, health, sex life or sexual orientation, or biometric data, about any person other than the publisher of the video;
- rely on Output for medical, legal, financial, safety-critical, employment, evidentiary or compliance decisions, or in any use classified as high risk by Annex III of Regulation (EU) 2024/1689, without independently verifying it against the source;
- work around quotas or rate limits, including by registering extra accounts;
- resell, rebrand or scrape the Service to feed another service; or
- breach export control or sanctions law.

## 9. Third-party platforms and no affiliation

Each source platform has its own terms and you must follow them. You instruct us, and authorise us for that purpose alone, to retrieve and process the material at the URL you submit on your behalf. We act only on that instruction and hold no relationship with the source platform on our own account. We do not agree to a platform's terms for you, and we stop when a platform blocks or rate-limits us.

We are not affiliated with, endorsed by or sponsored by YouTube, X, Instagram, TikTok, Twitch, Vimeo, Facebook, Bilibili, VK, Dailymotion or Reddit, or their owners, including Google and Meta. Their names describe compatibility only.

## 10. Content complaints

If you believe the Service has been used to infringe your rights or to reach illegal content, write to legal@transcriptor-mcp.org, identifying the work, the URL and your authority to act. We review reports we receive and act where appropriate, including by blocking a URL, a channel or a platform. This route is voluntary; we do not operate a statutory notice-and-action mechanism.

## 11. Output quality and no reliance

Output is produced automatically, from captions and metadata we do not write and do not check. It contains errors, omissions, wrong timings and wrong speaker attribution. Check Output against the source before you rely on it or publish it. Section 8 forbids the high-risk uses listed there.

## 12. The Service is free. Quotas, availability and changes

**The Service is supplied free of charge.** There is no subscription, no price and nothing to pay. Each signed-in user has an allowance of tool calls per UTC day, shown at sign-in; only tool calls count against it. When it is used up, further calls are refused until the next UTC day. We may change the allowance, and we may introduce paid plans in a future version of these Terms, which would take effect under section 18 and would never apply to a period already used.

Source platforms change and block access without warning, so a tool may stop working for a platform at any time. We may change, restrict or discontinue the Service or a tool only for a reason listed in section 18. Because the Service is free, you have no claim to continued availability, and we owe no refund of anything.

## 13. Suspension and termination

We may suspend, rate-limit or end access where the Service is used unlawfully or in breach of sections 7 or 8, where a request would infringe a third party's rights, where a complaint under section 10 is upheld, or where use threatens the security or availability of the Service. A person, not an automated rule, takes that decision. We tell you the reason unless the law prevents us, and you may reply to legal@transcriptor-mcp.org.

You may stop at any time by disconnecting the server in your MCP client, and delete your account in your MCPal account page.

## 14. Warranties

**Business users: THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE". ALL WARRANTIES, EXPRESS OR IMPLIED, INCLUDING AVAILABILITY, ACCURACY, NON-INFRINGEMENT, MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE, ARE EXCLUDED TO THE FULLEST EXTENT THE LAW ALLOWS.**

**Consumers:** we do not promise error-free Output, support for any particular video, or uninterrupted operation, and sections 3, 11 and 12 describe those limits. Where mandatory Spanish or EU law gives you rights in a digital service supplied without payment of a price, those rights are unaffected by this section.

## 15. Limitation of liability

**Nothing in these Terms excludes or limits our liability for death or personal injury caused by our negligence, for fraud or fraudulent misrepresentation, for wilful misconduct (dolo) or gross negligence (culpa grave), or for any other liability that cannot lawfully be excluded.**

Except for that paragraph, and because the Service is supplied free of charge, our total liability for all claims relating to one event is limited to **EUR 100**. **This financial cap applies to business users only.**

**Business users:** we are not liable for loss of profit, loss of business, loss of data, or indirect or consequential loss. **Consumers:** no monetary cap applies to you, and we are liable for foreseeable loss caused by our failure to perform this contract or by our lack of reasonable care and skill.

## 16. Indemnity (business users only)

If you are not a consumer, you will defend us against any third-party claim arising from a URL you submitted or the Output you received, and you will pay the resulting costs, losses, settlements and awards, including legal fees. We will tell you about the claim promptly and let you take over its defence with counsel we approve, and we will not settle without your consent, which you will not unreasonably withhold.

## 17. Complaints, governing law and courts

Write to legal@transcriptor-mcp.org and we will reply within one month. We are not committed to, and are not obliged to take part in, any alternative dispute resolution scheme. A consumer may also complain to the consumer authority of their place of residence.

These Terms are governed by Spanish law. **If you are a consumer habitually resident in another EU or EEA State, this choice does not deprive you of the protection of the mandatory rules of the law of your country of residence, which continue to apply.**

**Consumers:** you may sue us in the courts of the State where you are domiciled or in the Spanish courts, and we may sue you only in the courts of the State where you are domiciled. **Business users:** the courts of Spain have exclusive jurisdiction.

## 18. Changes to these Terms

We may amend these Terms only for one of these reasons: a change in the law or in a supervisory authority's guidance; a change imposed by the MCPal platform or another supplier we depend on; a change in the technical features of the Service; or the introduction of a paid plan.

We give at least **30 days' notice** by e-mail, and additionally in the sign-in flow, with the new version number and the date it takes effect. Changes are not retroactive. Before that date you may stop using the Service, which costs you nothing.

## 19. General and contact

If a court finds a provision unenforceable, that provision is removed and the rest stays in force.

The Service operator, Spain. E-mail: legal@transcriptor-mcp.org.
