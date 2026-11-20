# Kiro Mask — Good-Faith Legal Position & Disclaimer

> [!IMPORTANT]
> This is an internal statement of our **good-faith interpretation** of the published AWS/Kiro terms as they applied on **20 November 2026**. It was not written by formally certified legal counsel, and it does not constitute a guarantee of any outcome, nor is it a grant of permission by Amazon or AWS. Terms change; this document should be revisited whenever they do. Verbatim copies of the documents relied on, captured on that date, are frozen in [`legal-snapshots/2026-11-20/`](legal-snapshots/2026-11-20/MANIFEST.md). This defense is expressly keyed to that snapshot.

### Summary:
> We use an unmodified Kiro IDE — an AWS-provided client that is usable without the metered model service — as a local front-end on our own machine, over our own network traffic, with model providers we pay for ourselves. We send nothing false to AWS, modify nothing, extract no source code, avoid no fee, and claim no affiliation. On the published terms, we do not believe that constitutes a breach. This is our interpretation, not legal advice, and it does not extend to redistribution or commercial deployment.

---

## 1. What this project is

Kiro Mask is a **local interoperability tool**. It runs on the user's own machine, starts an **unmodified** Kiro IDE/CLI process with an OS-level proxy configuration, and terminates selected HTTPS connections using a certificate authority generated locally on that machine. Requests the user's own Kiro client makes are either:

- forwarded unchanged to the real AWS/Kiro endpoint, or
- answered locally, and translated to/from an OpenAI-compatible or Anthropic-compatible endpoint the user already has legitimate access to (OpenRouter, NVIDIA NIM, a local gateway, etc.).

It does not patch, unpack, repack, or replace any Kiro binary or resource. It does not extract or embed Kiro source code. It does not transmit fabricated data to AWS or Amazon: anything synthetic is generated locally and ends at the local client. No AWS account, credential, subscription or credit balance is altered or bypassed by the tool itself. All read data is data the user has rights of access to.

**Intended use:** private, local, non-commercial use by a person who lawfully obtained Kiro and wants to use the IDE's editor, agent, spec, steering, hook and MCP surface with model providers of their own choosing. Real Kiro models remain available in the default configuration (`kiro.enabled: true`, `kiro_endpoint.models: true`).

The project is distributed under the [PolyForm Noncommercial License 1.0.0](https://polyformproject.org/licenses/noncommercial/1.0.0) (`LICENSE` at the repository root), which permits non-commercial use, modification and new works. Commercial use requires a separate agreement with the maintainers and is outside the scope of this position.

---

## 2. The central interpretation: the IDE and the model service are distinct

The project's position rests on a distinction that AWS's own documents support:

- **Kiro IDE / CLI is client software.** [kiro.dev/license](https://kiro.dev/license) states: *"The Kiro IDE and Kiro CLI are each licensed to you as 'AWS Content' under the AWS Customer Agreement or other written agreement with us governing your use of AWS services, and the AWS Intellectual Property License."*
- **The metered thing is the model/agent service.** AWS Service Terms §1.24 and §50.14 list **Kiro** among the AI Services; §50.1 defines Kiro as an "AI Service." AWS pricing attaches to Kiro subscriptions and model usage — not to the downloadable IDE binary.
- **"Service" is defined broadly.** AWS Customer Agreement §12: *"'Service' means each of the services made available by us or our affiliates, including those web services described in the Service Terms. Services do not include Third-Party Content."*
- **"AWS Content" is defined separately and explicitly excludes the Services.** §12: *"'AWS Content' means APIs, WSDLs, sample code, software libraries, command line tools, proofs of concept, templates, advice, information, programs (including credit programs) and any other Content made available by us and our affiliates related to use of the Services or on the AWS Site and other related technology... AWS Content does not include the Services or Third-Party Content."*

It follows that Kiro-the-Service and the Kiro IDE client are **not the same thing** under the agreement. The IDE is AWS Content *related to* use of the Services; the Service is the AWS-hosted model/agent capability.

That distinction strengthens our position rather than weakening it:

1. We use the IDE as an IDE — editor, specs, steering, hooks, MCP, local sandbox, checkpoints. These are documented Kiro features and do not require model inference. We are therefore using an AWS-provided product in a manner consistent with its purpose.
2. Declining to engage the metered model service is **not** a misuse of it. A customer is free not to purchase a service.
3. Because both the client and Kiro itself fall within the agreement's broad notion of "Services," using the IDE is "in connection with your permitted use of the Services" — the exact language of the license grant (quoted below).

---

## 3. The contractual language we rely on

**AWS Customer Agreement §6.4 (Restrictions), in relevant part:**

> "Neither you nor any End User will use the AWS Content or Services in any manner or for any purpose other than as expressly permitted by this Agreement. Neither you nor any End User will, or will attempt to (a) reverse engineer, disassemble, or decompile the Services or AWS Content or apply any other process or procedure to derive the source code of any software included in the Services or AWS Content (except to the extent applicable law doesn't allow this restriction), (b) access or use the Services or AWS Content in a way intended to avoid incurring fees or exceeding usage limits or quotas, or (c) resell the Services or AWS Content. [...] You will not misrepresent or embellish the relationship between us and you [...] You will not imply any relationship or affiliation between us and you except as expressly permitted by this Agreement."

**AWS Intellectual Property License §3 (License), in relevant part:**

> "AWS Licensor grants you a limited, royalty-free, revocable, non-exclusive, non-sublicensable, non-transferrable license to copy and use the AWS Content **solely in connection with your permitted use of the Services** during the Term."

**AWS Intellectual Property License §4 (License Restrictions):**

> "Neither you nor any End User will use the Services or AWS Content in any manner or for any purpose other than as expressly permitted by this License and the Agreement. Neither you nor any End User will, or will attempt to (a) modify, distribute, alter, tamper with, repair, or otherwise create derivative works of any Content included in the Services or AWS Content [...] or (b) sublicense the Services or AWS Content."

**AWS Acceptable Use Policy:**

> "You may not use, or facilitate or allow others to use, the Services or the AWS Site: for any illegal or fraudulent activity; to violate the rights of others; [...] to violate the security, integrity, or availability of any user, network, computer or communications system, software application, or network or computing device; [...]"

**AWS Service Terms §1.1:**

> "You may not transfer outside the Services any software (including related documentation) you obtain from us or third party licensors in connection with the Services without specific authorization to do so."

Sources: [AWS Customer Agreement](https://aws.amazon.com/agreement/) (last updated 29 Oct 2026), [AWS Service Terms](https://aws.amazon.com/service-terms/) (last updated 19 Nov 2026), [AWS IP License](https://aws.amazon.com/legal/aws-ip-license-terms/) (last updated 27 Oct 2025), [AWS AUP](https://aws.amazon.com/aup/) (last updated 1 Jul 2021), [Kiro License](https://kiro.dev/license), [Kiro models](https://kiro.dev/docs/models/), [Kiro TLS inspection](https://kiro.dev/docs/enterprise/tls-inspection/), [Kiro firewalls/proxies](https://kiro.dev/docs/privacy-and-security/firewalls/). Verbatim local copies of every one of these pages, with source URLs, retrieval timestamps and SHA-256 hashes, are in [`legal-snapshots/2026-11-20/`](legal-snapshots/2026-11-20/MANIFEST.md). All quotations above are taken from that snapshot.

---

## 4. Our position against specific interpretations

### 4.1 "You send fabricated data to AWS / commit fraud / circumvent billing"

**Position: factually incorrect for the intended use.**

All synthetic responses — model lists, session titles, usage-limit answers, update checks, and (where a configuration explicitly enables them) authentication-like responses — are produced by the local proxy and terminate at the local Kiro client. Nothing fabricated is transmitted to AWS or Amazon. Where a request is forwarded, it is forwarded **verbatim** with the user's own credentials. Nothing is forged, no false metering or billing record is submitted, no account is obtained by misrepresentation.

CA §6.4(b) speaks of access or use "**in a way intended to avoid incurring fees or exceeding usage limits or quotas**." By its terms it presupposes a fee that would otherwise be incurred, or a limit that would otherwise be exceeded. A user who does not engage the metered model service incurs no fee to avoid and cannot exceed a quota they never approach. Where real Kiro models are used (the default), genuine credits are consumed and charged. This is a decision not to purchase a service, not an evasion of a fee.

### 4.2 "You modified Kiro / created a derivative work"

**Position: factually incorrect.**

No Kiro binary, bundle, resource file, configuration file or packaged asset is modified. Kiro is launched from its original installation with standard Electron/Chromium command-line flags and an OS proxy setting — both documented, ordinary mechanisms for controlling a locally launched application. IP License §4 prohibits modification, alteration, tampering with, or creating derivative works **of AWS Content**. Running an unmodified program with different network settings is not any of those acts. Service Terms §1.1 prohibits transferring software outside the Services; we copy and distribute no Kiro software.

**The VS Code parallel.** Kiro's editor lineage reinforces this. Kiro is a VS Code-compatible editor built on the same architecture — Kiro Mask's own launcher uses VS Code's `resources/app/out/cli.js` and `ELECTRON_RUN_AS_NODE` mechanics, and Kiro documents migration from VS Code. VS Code is MIT-licensed, general-purpose host software, and IP License §3 provides that where content is under a separate open-source licence, "the separate license will prevail with respect to the AWS Content or Third-Party Content that is the subject of such separate license." "AWS Content" is therefore not a monolith. Kiro is also built as an extensible host — extensions, MCP servers, hooks, custom agents and steering all change its behaviour without touching the installed binary. A local proxy is an external integration of the same kind: it adds a capability at a boundary rather than altering the program. We claim no right to modify Kiro's proprietary agent or protocol layer; the point is only that "derivative work" mischaracterises an unmodified host plus an external integration.

### 4.3 "You reverse-engineered Kiro / derived its source code"

**Position: not what §6.4(a) prohibits.**

CA §6.4(a) prohibits reverse engineering, disassembly or decompilation "**or apply[ing] any other process or procedure to derive the source code** of any software included in the Services or AWS Content." The project observes and interprets **wire protocol messages** emitted by the client — black-box interoperability work. It does not derive, reconstruct, extract or publish source code. No decompiler, disassembler or package-unpacking step is used in the shipping tool. The diagnostic folder contains traffic capture and decoding utilities, which analyse messages through network request interception, not program source.

We do not need to rely on it, but interoperability reverse engineering is expressly permitted or protected in several jurisdictions (e.g. EU Software Directive arts. 5–6; the narrow US DMCA §1201(f) exception). Our conduct falls comfortably short of what those provisions even regulate.

### 4.4 "You violated the AUP by attacking system security / integrity"

**Position: inapplicable.**

The AUP targets conduct that violates the security or integrity of *any user, network, computer, or communications system, software application, or device*. We operate only on our own machine, on our own client process, over traffic we ourselves generate and whose contents are our own prompts and code. We do not intercept third-party traffic, do not access systems without authorisation, and do not degrade any system's availability.

Kiro's own documentation contemplates TLS-inspecting firewalls and proxies in enterprise environments. Using a local CA and the standard `--ignore-certificate-errors` flag on a process we launched is a local configuration choice, not an attack on AWS. The one difference from an enterprise inspection deployment — substituting model endpoints — is a question of service configuration, not of system integrity.

### 4.5 "The license only permits using the IDE with AWS's own models"

**Position: no such term exists, and AWS's own product contradicts it.**

No clause in the Customer Agreement, IP License, Service Terms §50.14, or Kiro documentation states that Kiro IDE may only be used with AWS-provided models, or that third-party models are prohibited. IP License §3 says "solely in connection with your permitted use of the Services." "The Services" is a broad defined term that **includes Kiro**; using the Kiro IDE is therefore using a Service. The phrase is a purpose limitation on the grant — it prevents extraction, sublicensing and repurposing of AWS Content — not a provider-exclusivity covenant. Reading it as "only with AWS's LLM" adds words the agreement does not contain.

The same conclusion follows from the platform's architecture. A VS Code-derived editor is a general-purpose host, not a single-purpose client for one model provider: VS Code is MIT-licensed and is routinely paired with extensions and AI providers of the user's choosing, and Kiro inherits that host model (see §4.2). Treating the IDE as usable independently of AWS's model service is therefore consistent with the kind of software it is, not a repurposing of it.

### 4.6 "You misrepresented an affiliation with AWS"

**Position: no.**

The project does not use AWS marks to imply endorsement, does not present itself as an AWS product, and does not claim sponsorship. References to Kiro and AWS are descriptive and nominative: they identify the software the tool interoperates with. Internal protocol compatibility — making a client believe its expected endpoint answered — is a technical interoperability measure on the user's own machine, not a representation to AWS or to the public about a business relationship.

### 4.7 "You sublicensed or resold AWS Content"

**Position: no, for the intended private use.**

The tool is distributed at no charge under the PolyForm Noncommercial License 1.0.0, which permits non-commercial use, modification and new works, and requires a separate commercial agreement for commercial use. It contains no Kiro binaries, no copied Kiro source, and no AWS Content. Users bring their own lawfully obtained Kiro installation and their own model credentials. Nothing is sublicensed or resold.

We acknowledge that distributing a tool whose utility derives from reimplementing a client's private interface raises the separate question addressed in §6 below. That is a distinct issue from private local use.

---

## 5. Optional features and their status

For completeness, the codebase contains opt-in configuration switches that alter local client behaviour: `auth_fake_login`, `strip_metering`, `force_toggle_usage_limits`, `strict_whitelist`, `block_other_when_custom`, `updates`, and `telemetry`. In both the shipped example config and the loader defaults, `auth_fake_login` and `strip_metering` are **false**, `force_toggle_usage_limits` is `null`, and `kiro_endpoint.models` is `true`.

These are diagnostic/offline conveniences, not part of the intended use described in §1. Our position does **not** depend on any of them: the core argument — local interception of one's own traffic with an unmodified client and no fabricated data sent to AWS — holds with every one of them disabled. We do not condone using any feature to obtain AWS-paid service without payment, to misstate usage to AWS, or to defeat an access control. Should AWS or Kiro communicate that any such feature is objectionable, we will remove or further restrict it.

---

## 6. Limits of this position

This disclaimer is deliberately scoped. It does **not** assert:

1. **Legal advice or certainty.** It is a good-faith reading of public documents, not a legal opinion. No court or regulator has tested these questions.
2. **Permission from AWS.** Silence in the terms is not an affirmative grant. It is our view that no prohibition applies to the intended use; AWS may disagree.
3. **That the same conclusion holds for commercial deployment.** The project's PolyForm Noncommercial License does not license commercial use; commercial access requires a separate agreement with the maintainers and is outside this position. The AWS IP License is likewise non-sublicensable and non-transferrable, and CA §11.9 restricts publicity concerning AWS Confidential Information. Any commercial deployment would require separate review under AWS terms and, preferably, written clarification from AWS. Publishing the source under the non-commercial licence is not itself commercial deployment.
4. **Immunity from operational enforcement.** Kiro applies automated abuse detection to all users. Automated systems may flag unusual client behaviour regardless of the contractual merits; Kiro's published documentation states that abuse may lead to suspension or termination. We consider the intended use not to be abuse, but we cannot control how automated systems classify it.
5. **That the terms will stay the same.** AWS may modify the Agreement and Service Terms by posting revisions. This document should be re-checked against the then-current terms before each release.

If Amazon or AWS communicates a different interpretation, we will treat that as the authoritative position for future versions and update this document and the project accordingly.

---

## 7. Evidence snapshot and the effect of later changes

This position was formed on **20 November 2026** against the exact text captured in [`legal-snapshots/2026-11-20/`](legal-snapshots/2026-11-20/MANIFEST.md). That folder contains the AWS Customer Agreement, AWS Service Terms, AWS IP License, AWS Acceptable Use Policy, Kiro License, and the Kiro documentation pages cited above, each with its source URL, retrieval timestamp, and SHA-256 hash.

The relevant point for any later assessment:

1. **The defense is historical.** It claims only that, on the terms published and captured on 20 November 2026, the intended use was not prohibited. It makes no claim about terms published after that date.
2. **Later revisions do not retroactively rewrite that record.** AWS may amend its terms by posting revisions, and continued use after a change may constitute acceptance of the new text. If that happens, a *new* position must be formed against the *new* text. The old snapshot remains the evidence of what the terms said when this project was developed.
3. **Preserve, don't overwrite.** When terms change, create a new dated snapshot folder and add a dated note here. Never modify or replace an existing snapshot; the hashes in its `MANIFEST.md` are the integrity check.
4. **Where the two disagree, the snapshot governs this document.** If a live page later differs from the captured copy, the captured copy is what this defense was built on.

