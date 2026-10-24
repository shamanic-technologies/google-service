-- LEDGER-HISTORY-1024: the Gmail thread replies this service sent BEFORE it
-- recorded them (POST /orgs/google/thread-replies, 2026-10-16 .. 2026-10-23).
-- Idempotent (ON CONFLICT DO NOTHING); the thread-reply-outcomes sweep then
-- declares each one's message_sent, dated when Gmail accepted it.
--
-- Where each input comes from (all recorded facts, nothing estimated):
--   run_id           = the request run that sent it: runs-service run_events
--                      `gmail-thread-reply-sent` (written by this service), detail
--                      `message=<gmail id>`.
--   gmail_message_id = same event; the message must be in OUR mirror with the
--                      SENT label (the JOIN below drops any that is not).
--   lead_id          = lead-service `leads_campaigns.lead_id` of the row SERVED
--                      by the `lead-serve` run of the same workflow run (exactly
--                      one per send, 54 of 54).
-- sent_at = Gmail's internalDate (ms), never before the run started.
WITH input(run_id, gmail_message_id, lead_id) AS (VALUES
  ('1fbdca2c-2bde-4c28-b2c5-f90d409e9b39'::uuid, '1a144dc1e3c2e807', '41f58a13-99d0-4798-b38d-dd8548a50b82'),
  ('56d76982-51b8-4de0-8573-27e96eaa8b70'::uuid, '1a144dd402b90ddb', '1051ef0e-643b-4a36-95ee-e5e68e5cc105'),
  ('f372f044-2267-4b48-84a8-0ad9022ec40f'::uuid, '1a144de6cda2ed12', '79ae514a-7405-4c35-a0fa-baa4959b0ba9'),
  ('fafeb87b-bd0b-4e6b-b425-24d5b040c0f2'::uuid, '1a144e7a59833375', '16dcf48f-99c4-4e68-b29d-66f9253057a2'),
  ('ea4c6252-bab0-4d89-a996-818067a88eb1'::uuid, '1a144ea79f1001d6', 'd9144e73-3e95-4554-9e3f-4668f01dbf91'),
  ('4f8d3352-acdb-486d-bfe9-89ee2e019263'::uuid, '1a144f0d665be072', 'a523b16b-3b4f-445b-9ed7-9d4d9b1e2e61'),
  ('79259148-3550-4f76-bb48-1d6867421d5d'::uuid, '1a144f1bf6cbebb4', '3fbf4511-88af-4c54-884f-171ab9a09ed1'),
  ('9249d33b-8cd3-49f0-bcdc-b69bac747c6a'::uuid, '1a144f7a3efb6910', 'ee06c161-a491-4d98-9a58-49f0df904c05'),
  ('142232d9-5d0e-45e2-b00a-91509701cfb8'::uuid, '1a144f83c8d24b48', '53128d08-05fb-4b4e-a52a-8679013f3047'),
  ('c54e4405-d0bb-4d8d-b511-4411b2a44858'::uuid, '1a144f9b8a5f9016', '06ab9038-3f67-4bda-a0a4-1f85e904f612'),
  ('fa34c58f-faea-45cb-8692-0e11bd580de9'::uuid, '1a144fa5b14658d7', '52cba096-c04e-4a2f-b0e9-e2ec89b1e935'),
  ('993a4b49-556e-4557-8950-9b6909726e69'::uuid, '1a144fb0dddf06ca', 'e527fac8-0446-4084-9233-c3965fd86429'),
  ('8cb8c6c0-0794-4239-ad3c-573ac8daca56'::uuid, '1a144fba1e25c7f7', 'cc0b3968-192a-4c4c-a253-47ff67e64870'),
  ('b0556e9b-413d-475a-aaef-f78ec95c2efa'::uuid, '1a144fc08128b322', 'f199c384-9635-43bf-a8a3-2a2548494ad4'),
  ('f5c0da77-d993-47bd-90ea-c4dbf29f3b97'::uuid, '1a144fcedd3468b1', '44f7a673-073b-42ca-9c4a-59af848db9cc'),
  ('451cad76-b464-4f31-9e59-e9508f1b7a8b'::uuid, '1a144fd6b0033b00', 'f15665cc-0ef0-4c2e-9258-b1be179b3248'),
  ('2f85bfd5-ed05-474c-ab23-460b279e9a33'::uuid, '1a144fe5b6a57f0a', '4f32101c-aec7-46df-b3bf-0a06e9e02211'),
  ('2a94a1e4-4b31-47a6-b693-d703f320d3c7'::uuid, '1a144ff6917487dc', '9fdb140b-48e6-4e6a-ac0e-a6faa88afaf4'),
  ('e5c30d59-a5f0-4abd-a801-a053e384221e'::uuid, '1a145013498507ac', 'd832f3a2-22f4-4828-9dac-ca7b1bd55ed7'),
  ('7e31643b-aeff-4c2f-b8bf-b75c53ed91d8'::uuid, '1a1450273c69c2bb', '7cb64d29-e5dd-4391-a2b5-1e15c0ee1782'),
  ('4bfd53f4-5a1e-48c0-83f1-086424a2b280'::uuid, '1a14502e41b929a1', '2f4a21f0-67ed-4786-8d1d-e29cccd5c73d'),
  ('555ffda6-e072-4653-9a66-cbb3c3632193'::uuid, '1a145037592e3b9e', '3817ac7b-19c1-42b2-a5dc-c1626db1c421'),
  ('882a43a3-f2a9-445e-b17a-28e90eeb6dab'::uuid, '1a1450410b3b36f5', '395a122a-6eba-4e7b-bf2d-0ef6d7434333'),
  ('46efce08-54b0-43a4-95b4-c3fd234c7e41'::uuid, '1a145051fc52244f', '1ab635cb-cfce-45a2-99fd-9314f9f00c29'),
  ('47682f12-3849-4382-8178-d3e8afa7ea41'::uuid, '1a1450597db4437a', '1df757fa-3ffa-4cf0-9c98-d63f6f65ab57'),
  ('43057194-a7bf-4c7d-93e2-5026d28df835'::uuid, '1a1450671e959048', '9c199358-9f1e-4e26-970b-18cf0276d26d'),
  ('bd962b3c-90bc-43e8-b5b9-801b6902f80b'::uuid, '1a1450714c55e735', '45aa81b6-f784-49f5-80cc-84a29c86d282'),
  ('f45c13d0-e16a-4173-99b5-d4f8c47e9a72'::uuid, '1a1450f5d31854a6', 'c8aeede7-d360-4253-b489-beebfa936b65'),
  ('4037bdb9-3d5e-4ff7-a0fb-939cf4dd942a'::uuid, '1a145154b5be1eaa', 'd2f3be7b-fae8-49fb-8b1d-2055ad7420f9'),
  ('33210792-ba1d-4818-9228-cd33ee43c067'::uuid, '1a145162092d0150', '47e79ba8-3634-405f-a473-22dd77da59dd'),
  ('b8dba12c-2033-4cb0-81f2-497b481efaf2'::uuid, '1a145178a43678c0', 'b0d2d48a-0ea2-466b-a09d-aff23f04cf1d'),
  ('b3e80be5-df48-42a2-919e-744549136467'::uuid, '1a151fe5b9cedc3b', '4b5fe9de-d44a-4660-a95b-93fad81f9ec0'),
  ('c9d73498-a453-432b-bf99-e9065f2aa972'::uuid, '1a1527b072e5e0e3', '94010dd4-9e4b-4063-9a39-dcfd3eec1ce0'),
  ('41c67b6b-6880-4cd1-85b0-6c64983bd2d4'::uuid, '1a152bfb1ca5d35b', '4477868b-1942-4776-b33b-7ec69727c4e2'),
  ('e95d3549-861c-4e8c-9a21-c2774183700a'::uuid, '1a152c1334cb0ab0', '8903705d-2f91-4804-b94f-97ba55e6767d'),
  ('1b1c1f53-5bcb-4f71-b78e-fe9d187e91c0'::uuid, '1a153b87860a6247', '8c800d60-4896-42b0-a487-f36cb2a12190'),
  ('4025fec3-60cb-40ed-813d-bd314cb3f7f5'::uuid, '1a153bc88b30b021', '13a3a65d-95a6-4272-a2ac-a09c2af27b65'),
  ('79799526-ca6e-4f94-8295-c84ce7f1e88f'::uuid, '1a153be60092841f', '119a9044-b529-4a94-a8dc-c6cddef8c242'),
  ('c1f1c492-54d2-40f4-a533-4fee707f0c9f'::uuid, '1a153bfaf428eba6', '3fc8a031-0f43-4b7f-9e63-a0662eb836c3'),
  ('126975f8-92fd-4fd7-b24d-7068f3e20cc0'::uuid, '1a153c35821b3961', 'e5448ee5-cbc7-4a20-92b3-2d3f23cc0836'),
  ('b354a991-ba58-4087-a3f4-2da0d1a3313a'::uuid, '1a1542ff87847cdd', '91ee706d-8a2d-4b50-b381-4a11975badab'),
  ('1c3726b9-297a-4663-945a-954011d3d876'::uuid, '1a154307238fd517', '2fc37a0a-7bcb-47a0-bc30-9a3f98a0153d'),
  ('88892a60-59a6-4d86-9cd4-e465512b0d61'::uuid, '1a155410589bc16b', '062dec7b-0575-4af8-83a8-0ec03b5af48a'),
  ('c5bb7a5a-f235-4c1b-bb58-7825a3279e46'::uuid, '1a155480fb890811', '11100e87-78be-4e2d-b624-62bee3ce16f8'),
  ('22504683-b3dc-44c1-9aec-b10eaea36df9'::uuid, '1a1554898a29686c', '1305b403-0b07-4182-974e-7f6eb8735c06'),
  ('4536dd7f-5942-4906-948a-ec508ab67aed'::uuid, '1a1554935e4873cd', '19031173-0208-4c05-9235-e79756591a95'),
  ('463e848e-5c99-4caa-ad08-e2f49f0f40fe'::uuid, '1a1554a581e54220', '1cd1eb43-b2ca-4325-aabe-1401bda8656a'),
  ('5e5fc3c5-10cb-407e-996f-8483507cc388'::uuid, '1a15556243058560', '4d76d63e-a592-4df2-a2d8-98569d9c3ff7'),
  ('0d797e48-53fd-46ef-b994-f85e58ee385d'::uuid, '1a15561d36801374', '7c3917b5-af43-4932-bfce-3ec6b9a4bf55'),
  ('f176bfa5-e506-476a-936f-9520c40e8e08'::uuid, '1a15566a89265268', 'c5b1cdd5-0d82-4dd6-ba1f-85c3b44bc053'),
  ('a011a8e1-ae31-4090-b4fa-8bbe7cb5112e'::uuid, '1a1558fdc6d7f660', '0969b103-d074-4a9e-9474-ab6b7c87eeb1'),
  ('ded550e1-f91c-46f3-ac71-55358909491f'::uuid, '1a164e09059a7ace', 'ee1f9af4-9620-4c5e-90b5-8700bb49db6a'),
  ('c423c01f-ed92-42e5-8f07-03d7066112df'::uuid, '1a164e3bec1518ce', '148e70ae-3034-4884-a3fa-2611095fd2eb'),
  ('2eacac93-0919-42d2-8c5c-e2f4d29836b9'::uuid, '1a16ad6efac85f19', '321f3a92-7842-4b10-a4d3-7758e80ded4e')
)
INSERT INTO gmail_thread_reply_sends
  (org_id, gmail_message_id, thread_id, mailbox, from_address, to_address, run_id, lead_id, sent_at)
SELECT r.org_id, r.gmail_message_id, r.thread_id, t.google_account_email, s.from_email, s.to_emails->>0,
       i.run_id, i.lead_id, to_timestamp((r.payload->>'internalDate')::bigint / 1000.0)
FROM input i
JOIN gmail_messages_raw r ON r.gmail_message_id = i.gmail_message_id
JOIN gmail_messages_silver s ON s.org_id = r.org_id AND s.gmail_message_id = r.gmail_message_id
JOIN google_oauth_tokens t ON t.id = r.google_account_id
WHERE s.labels ? 'SENT'
ON CONFLICT (org_id, gmail_message_id) DO NOTHING;
