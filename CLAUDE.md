# google-service

Google Ads API v23 wrapper for MCC agency management.

## Identity

All endpoints require `x-org-id` and `x-user-id` headers (UUIDs from client-service).
These are the internal org/user identifiers — never use Clerk IDs (clerkOrgId/clerkUserId).
The client-service is the source of truth for identity resolution.

## Stack

See global CLAUDE.md for shared stack details (TypeScript strict, Zod, Vitest+Supertest, Railway).
