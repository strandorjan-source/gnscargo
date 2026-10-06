# Carrier EDI preparation

The first requested recipient is **Sandnes Transport og Terminal AS**, using Opter.
The carrier register stores a non-secret `edi_system` preference (`opter`, `timpex`, or null).
It does not store endpoints or credentials and does not imply an active connection.

The order's **Send EDI til transportør** action loads the current saved order, stops and
carrier register under the user's existing Supabase session/RLS. A mismatched carrier ID
cannot select another recipient. The dialog displays **Ikke tilkoblet** and disables sending.
It permits a local mapping-review sample download. There is no delivery request, queue,
sent status update or external order submission in this release.

The sample is explicitly `gns-cargo-edi-review` version 1.0. It is **not** an Opter-standard
API request. Opter documents support for customer-specific JSON formats, but their EDI
team must configure and approve the mapping before these data can be imported:
https://docs.opter.com/no/edi-006.htm

Only explicit transport fields are included. Customer account/name/reference, customer
sales price, Capacity reservation notes, user identities and internal pickup phones are
excluded. The existing text sanitizer also removes known pickup numbers copied into text.
Carrier freight is labeled separately in NOK. Pickup date-only values stay date-only;
no artificial loading time is introduced. Additional stops retain their own details.
The existing delivery checkbox removes the delivery fields when deselected. The optional
delivery behavior must be agreed with Opter because their usual booking requires delivery
addresses. No missing addresses, postal codes, countries or customer codes are invented.

## Required before enabling delivery

- Sandnes' confirmed API base URL and an enabled incoming EDI integration.
- A scoped API key, stored only in a server-side secret store.
- GNS Cargo's customer/account mapping and agreed service/price/vehicle field mapping.
- Agreement on multiple pickup/delivery stops, date-only loading, deferred delivery details,
  updates to an existing order and deduplication using the GNS reference.
- Test environment and agreed order acknowledgment/error format. API acceptance alone
  must not be displayed as an accepted transport assignment.

The next implementation needs authenticated server-side sending, authoritative rereading
and allowlisting, destination allowlisting, request deduplication and an audit trail that
distinguishes transport acceptance, order import confirmation and unknown outcomes.
No live orders were sent while preparing or verifying this release.

## Verification

`node tests/verify.cjs` exercises the actual DOM code with mocked Supabase queries:
carrier preference save, exact recipient matching after order edits, fresh reads,
privacy filtering, delivery exclusion, disabled sending, download without order mutations,
and logout cleanup. The existing Cargo/Capacity handoff and document tests also run.

`supabase/tests/carrier_edi_preparation.sql` runs in a rolled-back transaction on Supabase
and checks allowed preference values and the existing staff-only carrier access policies.
Production assets are compared byte-for-byte to the tested checkout after publication.
Actual Opter authentication, delivery and acknowledgments remain untested until Sandnes
provides and enables the connection.
