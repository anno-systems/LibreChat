# MCP catalog: candidates for German offices

Fifty further MCP servers worth building for offices in Germany, beyond those built or under way
(see "First servers" in [architecture.md](architecture.md)). Each row names how the server would
sign in, following the platform's three patterns:

- **User**: each user connects their own account (OAuth or a personal key), like Atlassian.
- **Tenant**: the tenant admin enters one credential; the server enforces per user what may be
  seen and done, like Personio.
- **Open**: public data without a credential, or the operator's key, like DeepL.

Priority: **A** many customers ask for it and an API exists; **B** strong in a segment; **C**
useful, but smaller reach or a harder API. "Writes" names the actions that need the tool policy's
`confirm` by default.

## Accounting, finance and banking

| #   | Server                                                          | Sign-in            | Priority | What it does                                                                                                  | Writes                     |
| --- | --------------------------------------------------------------- | ------------------ | -------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| 1   | DATEV (DATEVconnect online, Unternehmen online)                 | User (DATEV OAuth) | A        | Document upload to DATEV Unternehmen online, master data, accounting extracts for the client the user may see | Upload receipts            |
| 2   | Candis                                                          | Tenant             | B        | Invoices in approval, who has to approve, payment status                                                      | Approve or reject, comment |
| 3   | easybill                                                        | Tenant             | B        | Customers, invoices and reminders                                                                             | Invoice drafts             |
| 4   | Billomat                                                        | Tenant             | C        | Customers, offers, invoices                                                                                   | Drafts                     |
| 5   | Qonto                                                           | Tenant             | B        | Business account balance and transactions, receipts missing                                                   | Attach receipt             |
| 6   | Bank accounts via PSD2 (finAPI or GoCardless Bank Account Data) | User               | A        | Balances and transactions of the user's own business accounts at any German bank                              | None                       |
| 7   | Pliant or Moss (corporate cards)                                | Tenant             | C        | Card transactions, missing receipts, budgets per team                                                         | Request a card limit       |

## ERP and merchandise management

| #   | Server                                  | Sign-in        | Priority | What it does                                                    | Writes                 |
| --- | --------------------------------------- | -------------- | -------- | --------------------------------------------------------------- | ---------------------- |
| 8   | Microsoft Dynamics 365 Business Central | User (Entra)   | A        | Customers, items, sales and purchase documents, stock           | Quote and order drafts |
| 9   | SAP Business One (Service Layer)        | Tenant         | B        | Business partners, items, orders, open items                    | Drafts                 |
| 10  | SAP S/4HANA Cloud (OData APIs)          | User (SAP IAS) | B        | Sales orders, purchase orders, material and partner master data | Drafts, notes          |
| 11  | Xentral                                 | Tenant         | B        | Orders, articles, stock, shipping status                        | Order notes            |
| 12  | weclapp                                 | Tenant         | B        | CRM, sales orders, tickets, projects                            | Drafts, tickets        |
| 13  | JTL-Wawi (JTL REST API)                 | Tenant         | B        | Orders, articles, stock levels for online retailers             | None at first          |
| 14  | plentymarkets                           | Tenant         | C        | Orders, items, stock, marketplace status                        | Order notes            |

## HR, time and shift planning

| #   | Server     | Sign-in | Priority | What it does                                                       | Writes                           |
| --- | ---------- | ------- | -------- | ------------------------------------------------------------------ | -------------------------------- |
| 15  | Factorial  | Tenant  | B        | Own profile, time off, who is away, documents (Personio's pattern) | Request time off                 |
| 16  | HRworks    | Tenant  | B        | Own absences and working time, travel expenses                     | Request absence, record time     |
| 17  | Kenjo      | Tenant  | C        | Directory, absences, own time sheets                               | Request absence                  |
| 18  | Clockodo   | User    | A        | Record and look up working time per customer and project           | Start or stop a clock, add entry |
| 19  | Papershift | Tenant  | C        | Own shifts, open shifts, swaps                                     | Apply for a shift                |
| 20  | absence.io | Tenant  | C        | Absence calendar and own requests                                  | Request absence                  |
| 21  | MOCO       | User    | A        | Agencies: projects, budgets, time entries, invoices                | Time entries                     |

## CRM, sales and marketing

| #   | Server            | Sign-in      | Priority | What it does                                              | Writes                   |
| --- | ----------------- | ------------ | -------- | --------------------------------------------------------- | ------------------------ |
| 22  | HubSpot           | User (OAuth) | A        | Contacts, companies, deals, notes, tickets                | Notes, tasks, deal stage |
| 23  | Pipedrive         | User (OAuth) | A        | Deals, persons, activities                                | Activities, notes        |
| 24  | Salesforce        | User (OAuth) | A        | Accounts, opportunities, cases (SOQL bounded)             | Tasks, notes             |
| 25  | CentralStationCRM | Tenant       | C        | German small-business CRM: people, companies, deals       | Notes                    |
| 26  | CleverReach       | Tenant       | B        | Newsletter lists, campaign results (German, GDPR-focused) | Campaign drafts          |
| 27  | Brevo             | Tenant       | B        | Contacts, campaigns, transactional mail statistics        | Campaign drafts          |

## Communication and telephony

| #   | Server          | Sign-in      | Priority | What it does                                                          | Writes                        |
| --- | --------------- | ------------ | -------- | --------------------------------------------------------------------- | ----------------------------- |
| 28  | Microsoft Teams | User (Entra) | A        | Channels and chats the user is in, meeting transcripts and recordings | Post to a channel or chat     |
| 29  | sipgate         | User (OAuth) | A        | Call history, voicemails (transcribed), SMS, fax status               | Send SMS or fax, start a call |
| 30  | Zoom            | User (OAuth) | B        | Meetings, recordings, transcripts                                     | Schedule a meeting            |
| 31  | Stackfield      | Tenant       | C        | German collaboration suite: rooms, tasks, discussions                 | Tasks, comments               |

## Documents, storage and signatures

| #   | Server            | Sign-in      | Priority | What it does                                                  | Writes                   |
| --- | ----------------- | ------------ | -------- | ------------------------------------------------------------- | ------------------------ |
| 32  | Nextcloud         | User (OAuth) | A        | Files, shares, Deck boards, calendar on self-hosted Nextcloud | Upload, share, cards     |
| 33  | DocuWare          | User         | A        | Document search in file cabinets, index data, workflow tasks  | Store, complete a task   |
| 34  | d.velop documents | User         | B        | DMS search, records, approval workflows                       | Complete a workflow step |
| 35  | ELO ECM           | User         | B        | Archive search, metadata, workflows                           | Workflow steps           |
| 36  | Skribble          | Tenant       | B        | Qualified electronic signatures (eIDAS): request, status      | Send for signature       |
| 37  | DocuSign          | User (OAuth) | B        | Envelopes, status, templates                                  | Send for signature       |

## Projects and tasks

| #   | Server      | Sign-in      | Priority | What it does                                                      | Writes              |
| --- | ----------- | ------------ | -------- | ----------------------------------------------------------------- | ------------------- |
| 38  | Asana       | User (OAuth) | A        | Projects, tasks, assignments                                      | Tasks, comments     |
| 39  | monday.com  | User (OAuth) | A        | Boards, items, updates                                            | Items, updates      |
| 40  | OpenProject | User (OAuth) | B        | Work packages, projects, time on self-hosted OpenProject (German) | Work packages, time |
| 41  | awork       | User (OAuth) | C        | German agency projects, tasks, time                               | Tasks, time         |

## E-commerce and shipping

| #   | Server                      | Sign-in | Priority | What it does                                               | Writes                  |
| --- | --------------------------- | ------- | -------- | ---------------------------------------------------------- | ----------------------- |
| 42  | Shopware 6                  | Tenant  | A        | Orders, customers, products, stock (German shop system)    | Order status, notes     |
| 43  | Shopify                     | Tenant  | B        | Orders, products, customers                                | Order notes, fulfilment |
| 44  | Amazon Selling Partner API  | Tenant  | B        | Orders, inventory, returns for sellers                     | None at first           |
| 45  | Sendcloud                   | Tenant  | B        | Labels for DPD, GLS, Hermes, UPS; tracking; returns        | Create label            |
| 46  | Deutsche Post Internetmarke | Tenant  | B        | Postage for letters as PDF (the DHL server covers parcels) | Buy postage             |

## Public registers and open data

| #   | Server                                                    | Sign-in | Priority | What it does                                                                 | Writes |
| --- | --------------------------------------------------------- | ------- | -------- | ---------------------------------------------------------------------------- | ------ |
| 47  | VAT id check (BZSt eVatR and EU VIES)                     | Open    | A        | Qualified confirmation of a customer's VAT id with name and address          | None   |
| 48  | Company registers (Handelsregister, Unternehmensregister) | Open    | B        | Register entries, shareholders' list availability, register court and number | None   |
| 49  | Deutsche Bahn (timetable, disruptions)                    | Open    | C        | Connections and delays for business travel                                   | None   |
| 50  | Public holidays and school holidays per state             | Open    | B        | Holidays per Bundesland for planning, deadlines and absence questions        | None   |

## Industries

Built 2026-10-31 (`anno-systems/mcp-servers` #27):

| Server                                    | Sign-in                                    | What it does                                                               | Writes                            |
| ----------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- | --------------------------------- |
| Federal law (rechtsinformationen.bund.de) | Open                                       | Federal laws with one paragraph's current wording, federal court decisions | None                              |
| advoware (law firms)                      | User (Kürzel and online services password) | Files, parties, document list, own appointments and deadlines              | Follow-ups, when allowed          |
| casavi (property management)              | Tenant                                     | Properties, units, contacts, tickets, posts                                | Ticket comments and status        |
| untermStrich (planning offices)           | Tenant, users link their staff id          | Projects, fees, addresses, own times and target hours                      | Booking time, when allowed        |
| PlanRadar (construction)                  | User (personal token)                      | Projects, tickets, documents                                               | Comments and status, when allowed |

Not built: RA-MICRO (a REST interface is announced, not published), DATEV Anwalt classic
(DATEVconnect runs locally in the firm), the beA (open only to law firm software vendors),
Aareon Wodis/RELion (partner contract through Aareon Connect), maklerverwaltungsprogramme
(BiPRO is insurer-to-broker SOAP; no public APIs found) and utilities' core systems (per-customer
projects).

## Notes

- **ELSTER** (from the owner's list) is not in this catalog's build plan for now: filing needs the
  ERiC library (native binaries, registered developer) and a company certificate per tenant. A
  later option is a server that only prepares the data and leaves the submission to the tax
  adviser's DATEV or to ELSTER itself.
- **Microsoft Teams** and **Dynamics 365 Business Central** run on the existing Entra consent and
  fit into the `microsoft` process like Entra lookups.
- Servers in public registers (47–50) need no customer setup and suit every tenant, so they can be
  on by default.
- Before building a vendor with special-category data (health, payroll), apply the same rules as
  Personio: the finest-grained tools and nothing the caller is not entitled to see.
