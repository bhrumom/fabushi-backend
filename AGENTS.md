# Fabushi Backend — Agent Instructions

These instructions apply repository-wide to AI-assisted development in `bhrumom/fabushi-backend`.

## CRITICAL: Repository ownership

This repository is the canonical source for **service backend, workers, API/backend proxy code and backend deployment logic**.

Before product-affecting work, verify repository identity. If the task belongs to another Fabushi split repository, switch there before editing. `bhrumom/fabushi` is a legacy migration/source-history repository, not an alternate implementation location.

## CRITICAL: Spec-first development — No Spec, No Code

Before changing product/runtime code, tests, schemas, contracts, dependencies, build/release configuration, migrations, security controls, or behavior-affecting files:
1. read this `AGENTS.md`;
2. read the applicable durable Spec/project/source-of-truth;
3. check `docs/specs/`;
4. reconcile the Spec with the latest explicit user requirement and live repository facts;
5. if no usable Spec exists, create/repair it first with `docs/specs/SPEC_TEMPLATE.md`.

Read-only investigation needed to understand the current state or write the Spec is allowed before the Spec is complete. Product implementation is not.

## Mandatory lifecycle

**Discover → Spec → Architecture/Plan → Implement → Verify → Spec Compliance Review → Integrate/Deliver**

Before completion, compare the final implementation with every requirement/acceptance criterion and record `passed`, `blocked`, or `not-applicable` with evidence/reason.

Do not use chat memory as the only durable requirement source, silently change scope, weaken acceptance criteria, or leave a deliberate behavior/design change undocumented.

Canonical policy: `docs/specs/spec-first-ai-development.md`.
