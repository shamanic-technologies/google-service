// LEDGER-RESIDUAL-1025: mark as staff_experiment the google-service request runs
// that staff probes BORROWED as x-run-id after they had closed.
//
// What happened: each run below is a google-service `request` run (a mirror read
// asked by crm-service people.build / instantly-service gmail-threads / an api-service
// route). google-service never forwards or returns its own run id except to the
// runs/key/chat calls it makes itself (judgments only). Yet other services' runs
// (chat-service complete / generate-image, workflow execute-workflow, campaign-service
// campaigns created straight against the service with that id as x-run-id) were filed
// as its children, every one of them started AFTER the google run had closed
// (32 s to 70 min later), by the staff identity (kevin.lourd@gmail.com, the E2E test
// client) on staff orgs or as the agency. That is a hand probe borrowing a production
// run (global rule: "a probe borrowing a production run as x-run-id is marked on that
// run", cost-accounting doctrine).
//
// Selection (prod read 2026-10-25, runs_service): google runs with a non-google,
// non-judgments child; keep those whose ancestors carry no support mark or produced
// outcome AND whose subtree holds spend no declaring/marked run covers. 14 runs,
// $4.0310 of actual gross spend undeclared (3.5722 under crm people.build roots,
// 0.4115 under instantly gmail-threads roots, 0.0473 under an api-service sales-funnel
// root). 17 other borrowed runs were left alone: 0 undeclared below them, or already
// under a crm/api-service product_feature mark.
//
// Owner door, idempotent (an already-marked run keeps its first function): a replay
// writes nothing new. Run INSIDE the google-service container:
//   docker cp scripts/mark-borrowed-request-runs-20261025.mjs distribute-google-service-1:/tmp/
//   docker exec distribute-google-service-1 node /tmp/mark-borrowed-request-runs-20261025.mjs          # preview
//   docker exec distribute-google-service-1 node /tmp/mark-borrowed-request-runs-20261025.mjs --apply  # write

const RUN_IDS = [
  "2613408d-54fb-473e-bed5-f801dd6e2e80", // 1.7369 chat complete x32 (crm people.build, distribute.you)
  "3463e6a6-cf2b-4f1e-bd66-dec765960ae0", // 0.4583 chat complete (staff test org)
  "32478303-5bbf-498e-be05-8863f675b805", // 0.3946 workflow -> chat complete, industry-news-scan
  "1ccee994-16d1-4cba-a018-be26f2aea7fd", // 0.3522 generate-image + workflow (AscendQE, campaigns created on this id)
  "d53406ee-0afd-46e8-93c9-e722da015a8a", // 0.3256 chat complete (staff test org)
  "1c8092d0-285a-4467-b063-48778ce4706c", // 0.2372 workflow -> chat complete (instantly gmail-threads, staff test org)
  "8d5bfec2-a00b-4b3f-9cad-8274583c48de", // 0.1743 chat complete (instantly gmail-threads, staff test org)
  "0c911856-2ab3-41fd-b6e2-3be04cf68b35", // 0.1232 chat complete (staff test org)
  "cdca9000-d60c-49f1-aa6f-866b7a51016c", // 0.0911 chat complete
  "aacad424-699f-43e7-bbc1-bcdaf5e5a9dc", // 0.0530 chat complete
  "adbedf23-5f69-469b-be47-8b8b4353a748", // 0.0473 chat complete (api-service sales-funnel root)
  "f8741dc2-72e5-4f24-b2d8-e44493e76c90", // 0.0233 chat complete
  "69ffcc5a-f8dc-4197-80e9-f501df02602c", // 0.0080 crm people.timeline -> judgments
  "5459613c-3f84-43ee-975d-b441d0776cd2", // 0.0060 chat complete
];

const apply = process.argv.includes("--apply");
const url = `${process.env.RUNS_SERVICE_URL}/v1/platform-runs/support-marks/${apply ? "apply" : "preview"}`;
const res = await fetch(url, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": process.env.RUNS_SERVICE_API_KEY,
    "x-service-name": "google",
  },
  body: JSON.stringify({
    kind: "staff_experiment",
    reason:
      "google-service request run borrowed as x-run-id by a staff probe after it closed: the children (chat complete/generate-image, workflow, hand-created campaigns) are not google-service work (LEDGER-RESIDUAL-1025)",
    markedBy: "google-service LEDGER-RESIDUAL-1025 (session daegu-v2)",
    runIds: RUN_IDS,
  }),
});
console.log(res.status, await res.text());
if (!res.ok) process.exit(1);
