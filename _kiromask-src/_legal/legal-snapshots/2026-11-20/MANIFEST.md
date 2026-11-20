# Legal snapshot manifest — 20 November 2026

**Retrieved:** 2026-11-20T16:05:35-03:00 (local machine time) = 2026-11-20T19:05:35Z.
**Frozen for:** `.dev/LEGAL_POSITION.md` — the project's good-faith legal position, dated 20 November 2026.

## Why this exists

These are verbatim local copies of the public AWS and Kiro documents that the defense relies on, captured on **20 November 2026**. AWS and Kiro revise their terms by posting new versions on their websites. If that happens, this folder preserves the text that was in force when Kiro Mask was developed, so the defense can be assessed against the terms that actually existed at that time rather than against retroactively changed language.

**Do not edit or overwrite files in this folder.** If the terms change, create a new dated folder (e.g. `2027-01-15/`), keep this one intact, and note the change in `LEGAL_POSITION.md`. SHA-256 hashes below detect any accidental modification.

## Captured documents

| File | Source URL | Date printed in document | Bytes | SHA-256 |
|---|---|---|---:|---|
| `AWS-Customer-Agreement.md` | https://aws.amazon.com/agreement/ | Last Updated: October 29, 2026 | 67500 | `5C2D5920A49E2626B0ADFA2D8ED68506D5B128AA77CF302010DD991C9ED95DE5` |
| `AWS-Service-Terms.md` | https://aws.amazon.com/service-terms/ | Last Updated: November 19, 2026 | 318566 | `F5C95DCDA705FF5F98D8A1DD76FB4399D114123D1547620D5017135038822170` |
| `AWS-IP-License.md` | https://aws.amazon.com/legal/aws-ip-license-terms/ | Last Updated: October 27, 2025 | 6889 | `3057D4A2311FC3E083464CF829CEF3834A900E47CE7DA28307A8A24035CC744E` |
| `AWS-Acceptable-Use-Policy.md` | https://aws.amazon.com/aup/ | Last Updated: July 1, 2021 | 5189 | `CC10A9D8CEB3866B6C198328942482F0C4A724AD7EF1BD1967D6D614943133EA` |
| `Kiro-License.md` | https://kiro.dev/license | ©2026 (no explicit revision date) | 2904 | `DB0A0B7E2CC3E2D280DA5D656158F5717DE9955EB5B507409A7A060DDD63A111` |
| `supporting-docs/Kiro-data-protection.md` | https://kiro.dev/docs/privacy-and-security/data-protection.md | Page updated: October 23, 2026 | 14340 | `4F55523295DE197C79E3DE7454DFA73E37AF2250DF7F8101C41C50484861C9A0` |
| `supporting-docs/Kiro-models.md` | https://kiro.dev/docs/models.md | Page updated: November 16, 2026 | 15858 | `4D7519218F2A24206987AE901278116649CBF7C73DAB2C7968B247568CBDD693` |
| `supporting-docs/Kiro-tls-inspection.md` | https://kiro.dev/docs/enterprise/tls-inspection.md | No revision date printed | 2862 | `41A11D9C4D54549BF5F46DDE46084CE9E7F539FD2C6D7CEA3B2EF76F90D28535` |
| `supporting-docs/Kiro-firewalls-proxies.md` | https://kiro.dev/docs/privacy-and-security/firewalls.md | No revision date printed | 12537 | `3FFDCC88971570BDE4D6273E877EC757EAE7810EB396C870E674B9CE56436E02` |

## Licensing of these captured files

The documents in this folder are third-party materials: verbatim public copies of AWS and Kiro pages, © Amazon.com, Inc. / Amazon Web Services, Inc. or their affiliates. They are reproduced solely as dated evidentiary reference for `../../LEGAL_POSITION.md`. They are **not** covered by Kiro Mask's project licence (PolyForm Noncommercial License 1.0.0), and their presence here grants no rights in them. All rights remain with their respective owners.

## Verification

From the repository root:

```powershell
Get-ChildItem .dev\legal-snapshots\2026-11-20 -File -Recurse |
  ForEach-Object { "{0}  {1}" -f (Get-FileHash -Algorithm SHA256 $_.FullName).Hash, $_.Name }
```

The `supporting-docs/` files are Kiro **documentation**, not contract terms. They are included because the defense cites them for the IDE's local features, TLS-inspection compatibility, proxy/firewall behaviour, and AWS's multi-provider model catalogue.

## Caveat

A local copy is evidence of what the public page said on the retrieval date. It is not legal advice, and it is not proof that AWS would interpret those words the way the defense does. See `../../LEGAL_POSITION.md` for the interpretation itself.
