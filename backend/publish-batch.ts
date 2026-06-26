/** Publish a batch of user manuals (steps + hero screenshot + API endpoints, PII-safe). */
import { prisma } from './src/lib/prisma.js';

interface Manual {
  routePath: string; title: string; description: string;
  heroMediaId: string; heroImageUrl: string;
  steps: { title: string; instructionsMd: string }[];
  endpoints: { method: string; path: string; query?: string | null; status?: number; description?: string }[];
}
const U = (f: string) => `http://localhost:3000/uploads/${f}`;
const ep = (path: string, description: string) => ({ method: 'GET', path, status: 200, description });

const MANUALS: Manual[] = [
  {
    routePath: '/admin/chatConfig/chat-config', title: 'Configure Live Chat', description: 'Set how live chat behaves for your enterprise — routing, availability and chat settings.',
    heroMediaId: 'e1b76471-d17b-4a84-8a4c-c8bf97671387', heroImageUrl: U('1a241b69-bf2b-426b-b730-cec54b3dde97.png'),
    steps: [
      { title: 'Open Chat Config', instructionsMd: 'In the left menu, under **Configuration** open **Chat Config** (`/admin/chatConfig/chat-config`).' },
      { title: 'Adjust the settings', instructionsMd: 'Review and update the live-chat configuration for your enterprise (routing, availability and related options).' },
      { title: 'Save', instructionsMd: 'Save your changes to apply them across the Chat module.' },
    ],
    endpoints: [ep('/e/enterprise/chat_config', 'Loads/saves the enterprise chat configuration.')],
  },
  {
    routePath: '/admin/channels', title: 'Manage Channels', description: 'Connect and manage your messaging channels (WhatsApp, web, social) used across the platform.',
    heroMediaId: 'c42d7dde-2df4-4ba3-8eb3-6831f2b0d838', heroImageUrl: U('62f3a2e3-0945-4b36-a17c-881bec2e5689.png'),
    steps: [
      { title: 'Open Channels', instructionsMd: 'In the left menu, under **Configuration** open **Channels** (`/admin/channels`).' },
      { title: 'Review connected channels', instructionsMd: 'See each configured channel and its type. Channels are what campaigns, journeys and chat send through.' },
      { title: 'Add or edit a channel', instructionsMd: 'Add a new channel or open an existing one to update its configuration.' },
    ],
    endpoints: [ep('/e/enterprise/channels', 'Lists the enterprise channels.')],
  },
  {
    routePath: '/admin/whatsapp-onboarding', title: 'Onboard a WhatsApp Business Account', description: 'Connect a WhatsApp Business Account (WABA) to the platform.',
    heroMediaId: '0b16cbfd-e2cc-463a-8328-c8b9dd747cf6', heroImageUrl: U('b71d6fcd-e026-4b28-b808-dd6c8e4a4372.png'),
    steps: [
      { title: 'Open Waba Onboarding', instructionsMd: 'In the left menu, under **Configuration** open **Waba Onboarding** (`/admin/whatsapp-onboarding`).' },
      { title: 'Start onboarding', instructionsMd: 'Follow the steps to connect your **WhatsApp Business Account** and register the associated phone number(s).' },
      { title: 'Verify the connection', instructionsMd: 'Confirm the WABA is connected so it becomes available as a channel.' },
    ],
    endpoints: [ep('/e/enterprise/channels', 'Channels created/connected during onboarding.')],
  },
  {
    routePath: '/admin/messageTemplate/whatsapp', title: 'Manage WhatsApp Message Templates', description: 'Create, submit and manage WhatsApp message templates for campaigns and notifications.',
    heroMediaId: 'd45bdd5f-bd5b-456a-9677-56e3424a41d5', heroImageUrl: U('1ea897f2-567c-4f1f-b630-45d5159dee9c.png'),
    steps: [
      { title: 'Open Message Template', instructionsMd: 'In the left menu, under **Configuration** open **Message Template** (`/admin/messageTemplate/whatsapp`).' },
      { title: 'Create a template', instructionsMd: 'Add a new WhatsApp template (header, body, buttons) and submit it for WhatsApp approval.' },
      { title: 'Manage existing templates', instructionsMd: 'Review template status (approved / pending / rejected) and edit or reuse them in campaigns.' },
    ],
    endpoints: [],
  },
  {
    routePath: '/whatsapp-flow', title: 'Build WhatsApp Flows', description: 'Create and manage WhatsApp Flows — interactive, form-like in-chat experiences.',
    heroMediaId: '252b4f6b-f49e-4b9b-a6d3-fae59ee1ea4d', heroImageUrl: U('2b2d6c59-1897-4b07-a2b9-d92fbc168511.png'),
    steps: [
      { title: 'Open Flows', instructionsMd: 'In the left menu, under **Configuration** open **Flows** (`/whatsapp-flow`).' },
      { title: 'Create a flow', instructionsMd: 'Build a new WhatsApp Flow — an interactive, multi-screen in-chat form (e.g. booking, lead capture).' },
      { title: 'Manage flows', instructionsMd: 'Review existing flows and edit or publish them to a channel.' },
    ],
    endpoints: [ep('/e/enterprise/channels', 'Channels a flow can be published to.')],
  },
  {
    routePath: '/admin/integration', title: 'Manage Integrations', description: 'Connect third-party systems and APIs to the platform.',
    heroMediaId: '094b816f-a081-4510-8a42-7592126b1488', heroImageUrl: U('cd7711cf-fa2e-41da-b0f1-c7b56c2c11dc.png'),
    steps: [
      { title: 'Open Integration', instructionsMd: 'In the left menu, under **Configuration** open **Integration** (`/admin/integration`).' },
      { title: 'Add an integration', instructionsMd: 'Connect a third-party system or API (e.g. CRM, auth, external services) by configuring its credentials.' },
      { title: 'Manage integrations', instructionsMd: 'Review, edit or remove existing integrations.' },
    ],
    endpoints: [ep('/e/enterprise/appiyo_authconfig', 'Auth/integration configurations.')],
  },
  {
    routePath: '/customer-master/definition', title: 'Define Customer Fields (Customer Master)', description: 'Define the custom data fields stored against each customer record.',
    heroMediaId: '218b3909-c56e-4ffe-8a8f-fd1d026ee8bc', heroImageUrl: U('f5ce34fc-b6a9-404e-9029-49a805281ec4.png'),
    steps: [
      { title: 'Open Customer Master', instructionsMd: 'In the left menu, under **Configuration** open **Customer Master** (`/customer-master/definition`).' },
      { title: 'Define input fields', instructionsMd: 'Add or edit the **field definitions** that make up a customer record (name, type, validation) so customer data is captured consistently.' },
      { title: 'Save the definition', instructionsMd: 'Save your field definitions — they apply to all customer records and imports.' },
    ],
    endpoints: [ep('/chatbird/api/customer_master/inputfield_definitions', 'Customer-record field definitions.')],
  },
  {
    routePath: '/admin/enterpriseBilling', title: 'View Billing & Usage', description: 'Review your enterprise billing, usage and invoices.',
    heroMediaId: '45e3fa3d-0e82-49df-bfbc-3948f5ce9824', heroImageUrl: U('401322cc-2ded-4c04-b180-ee74a17ef3e7.png'),
    steps: [
      { title: 'Open Billing', instructionsMd: 'In the left menu, under **Configuration** open **Billing** (`/admin/enterpriseBilling`).' },
      { title: 'Review usage & charges', instructionsMd: 'See your enterprise usage and the associated billing/charges for the period.' },
    ],
    endpoints: [],
  },
  {
    routePath: '/admin/details', title: 'Manage Enterprise Details', description: 'View and update your enterprise profile and details.',
    heroMediaId: 'a4af77ad-fb3f-41bc-966b-16eadfc21a54', heroImageUrl: U('2078e8b0-1a38-4a6e-9073-bd77e00263f2.png'),
    steps: [
      { title: 'Open Enterprise Details', instructionsMd: 'In the left menu, under **Manage** open **Enterprise Details** (`/admin/details`).' },
      { title: 'Update the profile', instructionsMd: 'Review and edit your enterprise profile information and settings.' },
    ],
    endpoints: [ep('/e/enterprise/profile/', 'Enterprise profile details.')],
  },
  {
    routePath: '/admin/users', title: 'Manage Users', description: 'Create, edit and manage the user accounts (agents/admins) in your enterprise.',
    heroMediaId: '2f00bafe-e0d0-49a0-ae77-7edb126472f5', heroImageUrl: U('a055ac03-c633-4320-89cc-8acdb8ead1fa.png'),
    steps: [
      { title: 'Open Users', instructionsMd: 'In the left menu, under **Manage** open **Users** (`/admin/users`).' },
      { title: 'Add a user', instructionsMd: 'Create a new user account, set their details and assign a role.' },
      { title: 'Manage users', instructionsMd: 'Search the user list, then edit, deactivate or update roles for existing users.' },
    ],
    endpoints: [ep('/e/enterprise/users', 'Lists enterprise users.')],
  },
  {
    routePath: '/admin/sipusers', title: 'Manage External SIP Users', description: 'Manage external SIP (voice) user accounts used for call features.',
    heroMediaId: 'd9344c21-7003-414a-a650-57b4a24d9154', heroImageUrl: U('49f66992-580c-4e19-ba39-d75763a3c8b0.png'),
    steps: [
      { title: 'Open Ext SIP Users', instructionsMd: 'In the left menu, under **Manage** open **Ext SIP Users** (`/admin/sipusers`).' },
      { title: 'Add / manage SIP users', instructionsMd: 'Create and manage external **SIP** (voice) user accounts that connect to the calling features.' },
    ],
    endpoints: [ep('/e/enterprise/users', 'User accounts (incl. SIP).')],
  },
  {
    routePath: '/admin/departments', title: 'Manage Departments', description: 'Create departments and group agents for chat/call routing.',
    heroMediaId: 'b3577c4b-ef08-4dcc-b57b-7e5e457c65d8', heroImageUrl: U('810ef2a5-e5f2-4cd5-aa77-1a82fd0249ad.png'),
    steps: [
      { title: 'Open Departments', instructionsMd: 'In the left menu, under **Manage** open **Departments** (`/admin/departments`).' },
      { title: 'Create a department', instructionsMd: 'Add a department and assign agents/users to it — departments drive how chats and calls are routed.' },
      { title: 'Manage departments', instructionsMd: 'Edit membership and settings for existing departments.' },
    ],
    endpoints: [ep('/e/enterprise/departments', 'Lists departments.')],
  },
  {
    routePath: '/admin/audit_trail', title: 'Review the Audit Trail', description: 'Review a log of who changed what — by user, resource, action and date.',
    heroMediaId: 'e15fe327-0b29-41ce-8a2e-3200e5ae3231', heroImageUrl: U('93c93308-0245-4fe8-9a9c-1c854adf630b.png'),
    steps: [
      { title: 'Open Audit Trail', instructionsMd: 'In the left menu, under **Manage** open **Audit Trail** (`/admin/audit_trail`).' },
      { title: 'Filter the log', instructionsMd: 'Filter by **user**, **resource**, **action** and date range to find the changes you care about.' },
      { title: 'Review entries', instructionsMd: 'Each entry records who performed an action, on what resource, and when — useful for compliance and troubleshooting.' },
    ],
    endpoints: [
      ep('/chatbird/api/logs/audit/resource/list', 'Resources available to filter the audit log.'),
      ep('/chatbird/api/logs/audit/resource/action', 'Actions available to filter the audit log.'),
      ep('/chatbird/api/logs/audit/loggerType/list', 'Logger types for the audit log.'),
    ],
  },
  {
    routePath: '/admin/report', title: 'Message Delivery Report', description: 'Review message delivery across channels — sent, delivered, read and failed.',
    heroMediaId: '3bb6ff74-1a92-4957-906e-b19c8ba03281', heroImageUrl: U('886c4d85-8d18-48a5-bdea-c3e28d741182.png'),
    steps: [
      { title: 'Open Delivery Report', instructionsMd: 'In the left menu, under **Manage** open **Delivery Report** (`/admin/report`).' },
      { title: 'Filter & run', instructionsMd: 'Set the date range and any filters, then run the report.' },
      { title: 'Review delivery', instructionsMd: 'Review delivery outcomes (sent / delivered / read / failed) for your messages.' },
    ],
    endpoints: [],
  },
  {
    routePath: '/admin/trash', title: 'Recover Items from Trash', description: 'Review deleted items and restore or permanently remove them.',
    heroMediaId: 'ef6befc7-67c0-4e22-9b81-3293a6bfc1f0', heroImageUrl: U('b9a0b770-569d-4cb7-ae0f-cb63b02c56b9.png'),
    steps: [
      { title: 'Open Trash', instructionsMd: 'In the left menu, under **Manage** open **Trash** (`/admin/trash`).' },
      { title: 'Review deleted items', instructionsMd: 'Browse items that have been deleted across the platform.' },
      { title: 'Restore or purge', instructionsMd: 'Restore an item to bring it back, or permanently delete it.' },
    ],
    endpoints: [],
  },
  {
    routePath: '/admin/permission', title: 'Manage Roles & Permissions', description: 'Define roles and control what each role can see and do across the platform.',
    heroMediaId: '10741388-48c5-4f81-85c7-03aa944b14bc', heroImageUrl: U('05901d17-3773-44f1-8264-5446d0735203.png'),
    steps: [
      { title: 'Open Role & Permission', instructionsMd: 'In the left menu, under **Manage** open **Role & Permission** (`/admin/permission`).' },
      { title: 'Create or edit a role', instructionsMd: 'Add a role (or open an existing one) and set the permissions it grants.' },
      { title: 'Assign roles', instructionsMd: 'Roles are assigned to users in **Users** — controlling what each user can access.' },
    ],
    endpoints: [],
  },
];

for (const m of MANUALS) {
  const existing = await prisma.page.findUnique({ where: { routePath: m.routePath } });
  if (existing) { console.log(`skip ${m.routePath} (exists)`); continue; }
  const page = await prisma.page.create({ data: { routePath: m.routePath, title: m.title, description: m.description } });
  for (let i = 0; i < m.steps.length; i++) {
    const s = m.steps[i]!; const withHero = i === 0 && !!m.heroMediaId;
    await prisma.tutorialStep.create({ data: { pageId: page.id, stepNumber: i + 1, title: s.title, instructionsMd: s.instructionsMd, mediaAssetId: withHero ? m.heroMediaId : null, imageUrl: withHero ? m.heroImageUrl : null } });
  }
  if (m.endpoints.length) {
    await prisma.apiEndpoint.createMany({ data: m.endpoints.map((e, i) => ({ pageId: page.id, method: e.method, path: e.path, query: e.query ?? null, host: null, requestBody: null, status: e.status ?? null, contentType: 'application/json', responseSample: null, description: e.description ?? null, order: i })) });
  }
  console.log(`✓ ${m.routePath} — "${m.title}" (${m.steps.length} steps, ${m.endpoints.length} ep)`);
}
process.exit(0);
