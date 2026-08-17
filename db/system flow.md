# EVOPAY VSCU Sales Flow

## 1. Cashier Makes a Sale

**Cashier adds items → Enters customer name → Clicks "Complete"**

↓

## 2. Backend Saves to Database

- Sale is saved
- Stock is reduced
- Stock movement is logged
- Status: **Pending** *(waiting for KRA confirmation)*

↓

## 3. VSCU Signs and Sends to KRA

**Backend sends sale → VSCU signs → Forwards to KRA**

- KRA confirms the transaction
- VSCU returns the KRA signature

↓

## 4. Sale Becomes "Completed"

- Sale status is updated
- Receipt receives the KRA signature
- Reports are updated

---

# Offline / Queue Flow

```text
Sale Made
    │
    ▼
Saved Locally (Pending)
    │
    ▼
┌─────────────────────┐
│    Queued for Sync  │
│     (sync_queue)    │
└─────────────────────┘
    │
    ▼
When VSCU Comes Online
    │
    ▼
Auto-Sync to KRA

Nothing is lost — sales are placed in the sync queue and automatically synchronized when VSCU becomes available.

                    DATABASE
                  (Data)
                       │
                       │ 1. Sale saved here
                       ▼
        ┌─────────────────────────────┐
        │       BACKEND (Node.js)     │
        │                             │
        │  • Saves to database        │
        │  • Sends to VSCU            │
        └─────────────────────────────┘
                       │
                       │ 2. Send for signing
                       ▼
        ┌─────────────────────────────┐
        │            VSCU             │
        │                             │
        │  • Signs invoice            │
        │  • Forwards to KRA          │
        └─────────────────────────────┘
                       │
                       │ 3. KRA confirms
                       ▼
        ┌─────────────────────────────┐
        │         KRA eTIMS           │
        │                             │
        │  • Records tax data         │
        │  • Returns signature        │
        └─────────────────────────────┘
                       │
                       │ 4. Signature back
                       ▼
        ┌─────────────────────────────┐
        │       DATABASE UPDATED      │
        │                             │
        │  Status: Completed        │
        │  Signature: Stored         │
        └─────────────────────────────┘

        
        
        Summary
Step	Component	Action	Status
1	Cashier	Creates sale	New
2	Backend	Saves sale and reduces stock	Pending
3	VSCU	Signs and sends to KRA	Processing
4	KRA eTIMS	Confirms transaction	Confirmed
5	Backend	Stores KRA signature	Completed
6	Receipt	Displays KRA details	Final
Key Principle

Sale → Database → Sync Queue → VSCU → KRA eTIMS → Signature → Database Updated → Completed Receipt

If VSCU or KRA is temporarily unavailable:

Sale → Database → Pending → Sync Queue → Automatic Retry → VSCU → KRA