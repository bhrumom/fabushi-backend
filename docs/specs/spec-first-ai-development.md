# Spec-first AI development

Status: active
Date: 2026-09-21
Repository: `bhrumom/fabushi-backend`
Repository scope: service backend, workers, API/backend proxy code and backend deployment logic

## Rule

**No Spec, No Code.** Read the applicable durable Spec before product-affecting implementation. If none exists, create `docs/specs/<task-name>.md` from `docs/specs/SPEC_TEMPLATE.md` before implementation.

Read-only discovery may occur first only to understand the system and author/repair the Spec.

## Repository identity

This repository is authoritative only for the scope above. Work owned by another split repository must move there first. Legacy copies in `bhrumom/fabushi` are migration/reference material.

## Minimum Spec

Define context/problem, goal, non-goals, requirements, current/target state, architecture/ownership boundaries, interfaces/contracts/data flow where relevant, non-functional constraints, failure modes, implementation strategy, verification, acceptance criteria/Definition of Done, release/migration/rollback/observability where applicable, and references/provenance.

## Lifecycle

Discover → Spec → Architecture/Plan → Implement → Verify → Spec Compliance Review → Integrate/Deliver.

For each requirement/AC, record `passed`, `blocked`, or `not-applicable` with evidence/reason before completion. Latest explicit user requirements may supersede older text, but update the durable Spec before intentionally diverging from it.
