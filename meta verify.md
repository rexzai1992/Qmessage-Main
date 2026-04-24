# Meta App Review - `whatsapp_business_manage_events`

## App Context
- **App name:** qmessage
- **Platform/UI name:** qmessage
- **Product type:** Multi-tenant WhatsApp messaging platform for business inbox + automation
- **WhatsApp API model:** Cloud API + Embedded Signup

## Detailed Description Of Permission Usage
qmessage uses `whatsapp_business_manage_events` to log business outcome events on behalf of each connected WhatsApp Business Account (WABA), so those events can be sent to Meta for ads targeting, optimization, and reporting.

In qmessage, event generation is tied to real conversation outcomes from WhatsApp interactions, not synthetic traffic:

1. **Inbound trigger source**
   - Customer sends a WhatsApp message.
   - qmessage receives the webhook event and stores the message with timestamp.
   - Message is routed to the correct tenant workspace using tenant/WABA mapping.

2. **Outcome detection**
   - Outcome is determined from workflow state transitions and/or agent actions in the tenant inbox (examples: qualified lead, add-to-cart intent, confirmed purchase).
   - qmessage maps those outcomes to event types such as `LEAD`, `ADD_TO_CART`, and `PURCHASE`.

3. **Event logging to Meta**
   - qmessage submits the mapped event for the tenant's WABA through Meta APIs that require `whatsapp_business_manage_events`.
   - Payload includes event type, event timestamp, tenant-scoped WABA context, and business metadata needed for optimization/reporting (for example: value/currency/order reference when applicable).
   - qmessage records submission result and status for auditability and troubleshooting.

4. **Multi-tenant safety**
   - Event logging is always executed in the scope of the authenticated tenant (`company_id`), with strict tenant isolation.
   - One tenant cannot submit events for another tenant's WABA.

## Value For People Using qmessage
This permission provides direct operational value to business users running WhatsApp campaigns:

- Connects real WhatsApp conversation outcomes (lead, cart, purchase) to Meta ads performance.
- Improves optimization quality by feeding post-click/conversation outcomes back to Meta.
- Reduces manual export/import work for attribution reporting.
- Gives business teams a closed-loop flow: ad -> WhatsApp conversation -> conversion signal -> ads optimization.
- Helps teams spend budget more efficiently on audiences that convert through WhatsApp conversations.

## Why This Permission Is Necessary
`whatsapp_business_manage_events` is required because qmessage must submit event data **on behalf of tenant WABAs** to Meta for ads use cases.

Without this permission:
- qmessage cannot log these WhatsApp business events to Meta from the platform backend.
- qmessage cannot provide tenant-level conversion feedback loops for ads targeting/optimization.
- qmessage loses key functionality used by businesses to measure and optimize WhatsApp-driven campaign outcomes.

In short, this permission is not optional for our ads-conversion workflow; it is the control that allows qmessage to send the event signals that the feature is built on.

## Compliance And Data Handling
- qmessage logs events only for tenant accounts that explicitly connect and authorize their WABA.
- Customer messaging remains opt-in based; opt-out and policy controls are enforced in messaging workflows.
- Tenant data is isolated by `company_id` and profile ownership checks.
- Event/account data is stored with backend access controls and audited server-side processing paths.

## Implementation References (Current Codebase)
- WABA route and integration surface: `dashboard-server/routes/wabaRoutes.ts`
- Tenant-scoped data access and message persistence: `src/services/wa-store.ts`
- Tenant WABA config loading: `src/waba/registry.ts`
- Workflow-driven conversation outcomes: `src/workflow/engine.ts`
