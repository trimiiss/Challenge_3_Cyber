# Vula: plan to adoption

> Draft v0.2 (2026-11-23). Counts for 30 % of the score: "a real user, a real buyer, and a way to reach them".
> Target companies researched from public sources on 2026-11-23 (listed in §10). Claims marked *(self-reported)* come
> from a company's own or a directory profile and get confirmed in the first call. Prices are hypotheses to test in the
> pilot, not quotes.

## 1. The problem, in one line

Every IT company says "our audit logs are tamper-proof". In practice anyone with the database superuser key can
delete or edit them, and an auditor has no way to check independently that this didn't happen.

Concrete threat for the pitch: an insider with the `postgres` password changes a record (a grade, a payout, a
permission), deletes the matching audit rows, and edits the log copy too. Today that can be undetectable.

## 2. Who uses it, who pays, who influences

| Role | Who | What they get |
|---|---|---|
| **User** | Platform / DevOps lead or security engineer at an IT company running a Postgres (Supabase) backend | Drop-in collector and log server; alerts when audit evidence is altered or goes silent |
| **Buyer** | CTO (SME / startup) or CISO (corporate) | Evidence for ISO 27001 / SOC 2 audits and customer security questionnaires; insider-risk control without buying a SIEM |
| **Influencer** | External auditor / certification body; the customer's own security reviewers | An independent check (`vula verify-log`) that needs only a public chain RPC, not trust in the vendor |

Primary segment, matching the challenge (IT companies: corporates, startups, SMEs): **SaaS SMEs and IT
service companies (20–250 people) that sell to EU customers and are going through ISO 27001 or SOC 2**.

## 3. Why they would buy now

- **Audit requirements already ask for it.** ISO/IEC 27001:2022 Annex A control 8.15 (Logging) expects logs to be
  protected against tampering and unauthorised access. PCI DSS v4.0 requirement 10.3 asks that audit logs be protected
  from destruction and unauthorised modification. Today companies answer with "restricted access" plus WORM storage,
  which still trusts the account owner.
- **EU supply-chain pressure.** NIS2 (EU 2022/2555) and, for finance, DORA (EU 2022/2554) push security requirements
  down to IT suppliers. Vendors outside the EU who sell into it, including in Kosovo, get these requirements through
  customer contracts and questionnaires.
- **Kosovo's own rules point the same way.** The Central Bank of Kosovo's Regulation on ICT and Security Risk
  Management (2024) defines ICT risk to include "failure of integrity of systems and data", and a 2025 Regulation on
  Information Systems and Cyber Risk Management adds an audit section. Law No. 08/L-173 on Cyber Security (2023) set
  up the Cyber Security Agency, which receives incident notifications from operators of essential services and
  digital service providers. Tampering evidence that a third party can verify fits both.
- **What Vula adds that WORM / S3 Object Lock doesn't:** completeness proofs (nothing was dropped or reordered), and
  verification by an outsider without access to the vendor's cloud account.

## 4. Offer and pricing (hypotheses to validate in the pilot)

Open-core, so auditors can trust the checker:

| Tier | Price idea | Includes |
|---|---|---|
| **Verifier CLI** | Free, open source | `vula verify-log` / `reconcile`, anyone can audit any Vula log from the chain |
| **Starter** | ~€49 / month per log source | 1 Supabase/Postgres source, 5-min anchoring, dashboard, email alerts |
| **Team** | ~€199 / month | up to 5 sources, 1-min anchoring, real-time alerts, auditor read-only access, monthly integrity report PDF for the auditor |
| **Self-hosted** | annual licence, from ~€3k / year | runs fully in the customer's infra with their own Registry API instance (DCAP.Web) or Compellio Gateway account; SLA |

Cost driver to confirm with Compellio: one Registry API update per checkpoint. At a 5-minute interval that is
≤ 288 updates per source per day (≈ 8.6k / month); less when nothing happened, because we only anchor when there are new
events. **TODO:** get Gateway credit pricing and Etherlink gas cost per `push`, then check the margin per tier. The
anchoring interval is the main lever (shorter exposure window vs cost).

Partner angle for Compellio: every Vula customer is a recurring consumer of Gateway credits. Vula is a
cybersecurity channel for the Registry API.

## 5. First 3 target customers

One company per pitch angle, all based in Prishtina and reachable through the same ecosystem (STIKK, Enterprise
Europe Network KosInn). The contact person's name goes on each line after the first reply; we don't guess names.

| # | Company | Angle | Why they feel the pain (evidence) | User / buyer | First contact route |
|---|---|---|---|---|---|
| 1 | **ASEE SH.P.K**, Asseco SEE in Kosovo (Asseco SEE acquired Pronet, which Kosovo's investment agency called the country's largest IT company) | IT supplier to finance and payments | Certified to ISO/IEC 27001:2022 (MSECB) for internal IT, software development and data storage, so its logging control (A.8.15) is audited every year. The Asseco SEE group serves the financial, payment and public sectors, which fall under the CBK ICT risk rules (§3) | User: ISMS / security team. Buyer: country management with the group CISO | Email through the company's public contact asking for the ISMS owner, framed as "audit-proof evidence for 8.15"; follow up at STIKK events |
| 2 | **Kosbit** (50–249 staff) | IT outsourcing / managed services with admin access to client systems | Managed services, systems integration, BPO and penetration testing for large telecom clients *(self-reported: approved global vendor of AT&T)*; named among the IAOP World's Best Outsourcing Providers. Their clients' auditors need proof that the provider's admins didn't alter records; Vula turns "trust us" into a verifiable claim | User: service-delivery / operations lead. Buyer: CEO or CTO | Kosbit publishes partnership requests on the Enterprise Europe Network; answer through EEN KosInn, then a 20-minute demo |
| 3 | **Kosova Information Technology (KIT)** (since 2004, STIKK member) | Software house building public-sector record systems | *(self-reported)* 25 systems in use across Kosovo, including in ministries and government agencies (eHMS health system, gun management, time attendance). Records like these are insider targets, and disputes need independent evidence | User: KIT's delivery team. Buyer: KIT management, which resells Vula as a feature; end customer: the ministry's IT unit | STIKK member directory → direct email; pitch Vula as an add-on that strengthens their government tenders |

**Design partner for pilot #1: University "Isa Boletini" Mitrovicë (UIBM).** Our demo story is their real process:
exam grades are posted in the university's SMU (Sistemi i Menaxhimit Universitar) within fixed windows set by the
academic calendar. User: SMU administrators. Buyer: the rectorate. Reach: our own faculty (warm). The University
of Prishtina's in-house SEMS, which also has a grading module, is the next university target.

## 6. How we reach them

1. **Warm network first:** UIBM faculty (design partner above), then UIBM alumni at the companies below (check
   LinkedIn before writing; a warm intro beats a cold email). Outreach list of 10:

   | # | Organisation | Segment | Hook |
   |---|---|---|---|
   | 1 | ASEE SH.P.K | IT for finance and payments, ISO 27001 | Independent evidence for logging control A.8.15 and CBK ICT rules |
   | 2 | Kosbit | Managed services / outsourcing | Prove to clients that your admins didn't touch their records |
   | 3 | Kosova Information Technology (KIT) | Public-sector software house | Tamper-evident audit as an add-on in government tenders |
   | 4 | UIBM (SMU) | University | Design partner: grades are the demo story |
   | 5 | University of Prishtina (SEMS) | University, in-house system | Same grade-integrity story at Kosovo's largest university |
   | 6 | LinkPlus IT | Enterprise apps and application management (Prishtina + Skopje, exporting since 2013) | Admin access to clients' production systems; attends KosICT matchmaking |
   | 7 | Axians Kosovo Software Development & Consulting | Kosovo unit of VINCI Energies' ICT brand (ISO 9001) | The German side serves the public sector and critical infrastructure (KRITIS), so NIS2 requirements come down the chain |
   | 8 | Detay Tech | SaaS, ERP/CRM, fintech and education *(self-reported clients in CH, DE, AT, US)* | EU customer security questionnaires |
   | 9 | Appstellar | Fintech and health-tech projects, 25+ staff | Audit-trail integrity for regulated clients |
   | 10 | StarLabs | Software for international clients since 2015, incl. EdTech | Edtech records (grades, certificates) |

   **Timing:** outreach starts 24 Nov 2026. Goal before submission (13 Dec): 3 demo calls and one signed letter of
   intent for the 6-week pilot (§7), quoted in the report.
2. **Ecosystem channels in Kosovo:** STIKK (Kosovo ICT association) member events, Innovation Centre Kosovo,
   Innovation and Training Park Prizren, and the KosICT B2B matchmaking run by STIKK with EEN KosInn (15-minute
   one-to-one meetings; the 2026 edition was 9–10 Oct, so we register for 2027 and ask STIKK for introductions now).
   Offer a 20-minute "can your admin rewrite your logs?" live demo.
3. **Compellio / BlockJump:** introductions to Compellio's partners and other challenge participants. Ask for
   Gateway credits for the pilots.
4. **Referral partners:** ISO 27001 consultants and certification auditors, who get asked "what tool do you
   recommend?" by every client they audit.
5. **Developer channel:** open-source verifier and quickstart on GitHub, a Supabase-focused write-up ("tamper-evident
   audit logs for Supabase in 10 minutes"), later a listing as a Supabase integration.
6. **CERT angle (working in the PoC):** every tampering alert is shared as a STIX 2.1 incident through Compellio's
   BCBCTI (TAXII 2.1) and registered as its own TAR; KOS-CERT or a sector CSIRT verifies it from the chain with
   `vula verify-cti`, and sees only that tampering happened, not the underlying records.

## 7. Pilot plan (6 weeks, 1–2 design partners, free in exchange for feedback and a reference)

| Week | Step | Exit criterion |
|---|---|---|
| 1 | Install collector + log server against the partner's **staging** DB; anchor to Etherlink testnet | First anchored checkpoint |
| 2–3 | Read-only capture from **production** audit tables | 2 weeks with zero false alerts |
| 4 | Partner's auditor (or an external one) runs `vula verify-log` on their own machine | Auditor confirms the evidence is understandable and usable |
| 5 | Red-team day: we run the attack scripts (delete rows, edit leaves, truncate, stop collector) on staging | Every attack detected within one anchoring interval |
| 6 | Review: price test (show the tier table), decide on paid continuation | Signed letter of intent, or a clear "no" with the reason |

Metrics we report: time to detect, false alerts per week, setup time (target < 1 day), cost per source per month,
willingness to pay.

## 8. Risks and how we handle them

| Risk | Mitigation |
|---|---|
| "Blockchain" scepticism | Present it as a public, append-only timestamp. Only hashes go on-chain, no tokens or crypto for the customer. |
| Privacy / GDPR | Raw events stay in the customer's own Supabase/Postgres; the chain only gets Merkle roots and checksums |
| Dependence on one registry | The same client works with the Compellio Gateway or a self-hosted DCAP.Web; the verifier needs only a chain RPC |
| Attacker disables collection before acting | Heartbeat gaps raise alerts; documented honestly in the threat model |
| Cost at scale | One anchor covers thousands of events; the interval is configurable; we only anchor when there are new events |

## 9. What we ask from Compellio

Gateway API key and credits for the PoC and 2 pilots, a review of our Registry API usage, and introductions to 3 IT
companies in their network.

## 10. Sources (checked 2026-11-23)

- ASEE SH.P.K ISO/IEC 27001:2022 certificate: https://asee.io/asee_sh-p-k_-iso_certificate_2701_2022
- Pronet acquisition by Asseco SEE, Kosovo IT sector overview (KIESA): https://kiesa.rks-gov.net/desk/inc/media/BEDE5030-9831-4C90-942B-F17DC45D09CB.pdf
- Kosbit profile: https://clutch.co/profile/kosbit · IAOP Global Outsourcing 100: https://www.prweb.com/releases/kosbit-named-to-the-2019-best-of-the-global-outsourcing-100-r--875389729.html
- KIT member profile (STIKK): https://stikk.org/en/?p=7720
- UIBM academic calendar 2024–2025 (grade posting in SMU): https://umib.net/wp-content/uploads/2024/09/Kalendari-akademik-2024-2025.pdf
- University of Prishtina SEMS: https://fim.uni-pr.edu/page.aspx?id=2%2C22
- LinkPlus IT: https://clutch.co/profile/linkplus-it · Axians Kosovo ISO 9001: https://www.axians.de/app/uploads/sites/72/2025/11/Axians-Kosovo-Software-Development-Consulting-9001-EN_03.08.2023_Z-IMS-00206-EN_1.00.pdf
- Detay Tech: https://www.goodfirms.co/company/detay-tech · Appstellar: https://therecursive.com/?p=21334
- CBK Regulation on ICT and Security Risk Management: https://bqk-kos.org/wp-content/uploads/2024/12/15_REGULATION-ON-ICT-AND-SECURITY-RISK-MANAGEMENT.pdf
- CBK Regulation on Information Systems and Cyber Risk Management (2025): https://bqk-kos.org/wp-content/uploads/2025/09/ENG-Rregullore-per-sistemet-e-informacionit-1-1.pdf
- Law No. 08/L-173 on Cyber Security: https://cybilportal.org/publications/kosovo-law-no-08-l-173-on-cyber-security
- KosICT 2026 B2B matchmaking (STIKK + EEN KosInn): https://www.b2match.com/e/kosict-2026
