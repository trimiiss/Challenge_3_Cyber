# Vula: plan to adoption

> Draft v0.1 (2026-11-19). Counts for 30 % of the score: "a real user, a real buyer, and a way to reach them".
> Items marked **TODO(team)** need facts only the team has (names, contacts). Prices are hypotheses to test in the
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

One archetype per pitch angle. **TODO(team):** put a real company name and a named contact on each line before the
report. Only list companies we can actually reach.

| # | Archetype | Why they feel the pain | Name / contact |
|---|---|---|---|
| 1 | **SaaS SME on Supabase/Postgres selling to EU customers** (fintech, HR-tech, edtech) | Facing ISO 27001 / SOC 2 or customer questionnaires that ask "how do you protect audit logs?" | TODO(team) |
| 2 | **IT outsourcing / managed-services company** with admin access to client systems | Their clients need proof that the provider's admins didn't alter records; Vula turns "trust us" into a verifiable claim | TODO(team) |
| 3 | **Software house building university or e-government record systems** (grades, registries, permits) | Records are high-value targets for insiders (our UIBM demo story) and disputes need independent evidence | TODO(team) |

## 6. How we reach them

1. **Warm network first:** university contacts (the grades demo is a ready-made story), alumni at local software
   companies. **TODO(team):** list 10 names.
2. **Ecosystem channels in Kosovo:** STIKK (Kosovo ICT association) member events, Innovation Centre Kosovo,
   Innovation and Training Park Prizren. Offer a 20-minute "can your admin rewrite your logs?" live demo.
3. **Compellio / BlockJump:** introductions to Compellio's partners and other challenge participants. Ask for
   Gateway credits for the pilots.
4. **Referral partners:** ISO 27001 consultants and certification auditors, who get asked "what tool do you
   recommend?" by every client they audit.
5. **Developer channel:** open-source verifier and quickstart on GitHub, a Supabase-focused write-up ("tamper-evident
   audit logs for Supabase in 10 minutes"), later a listing as a Supabase integration.
6. **CERT angle (stretch feature):** detected tampering can be shared as a verifiable STIX sighting through
   Compellio's BCBCTI, which is relevant to KOS-CERT and sector CSIRTs.

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
