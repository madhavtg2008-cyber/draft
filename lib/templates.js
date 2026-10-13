// Starting documents a lawyer can create inside Zoit, filled in with the matter's details.
// Plain text in a simple shape the server turns into a formatted document:
// first line = title, "1. HEADING" lines = clause headings, everything else = paragraphs.

const TEMPLATES = [
  { id: 'blank', name: 'Blank document' },
  { id: 'nda', name: 'Mutual non-disclosure agreement' },
  { id: 'engagement', name: 'Engagement letter' },
  { id: 'services', name: 'Services agreement' },
  { id: 'employment', name: 'Employment agreement' },
  { id: 'lease', name: 'Commercial lease' },
  { id: 'poa', name: 'Power of attorney' },
  { id: 'notice', name: 'Legal notice' },
];

function render(id, ctx = {}) {
  const client = ctx.company || ctx.client || '[Client]';
  const person = ctx.client || '[Client name]';
  const other = ctx.counterparty || '[Counterparty]';
  const date = ctx.date || new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
  const lawyer = ctx.lawyer || '[Counsel]';
  const T = {
    blank: `${(ctx.title || 'UNTITLED DOCUMENT').toUpperCase()}
 `,
    nda: `MUTUAL NON-DISCLOSURE AGREEMENT
This Mutual Non-Disclosure Agreement (the "Agreement") is made on ${date} between ${client} and ${other} (each a "Party").
1. CONFIDENTIAL INFORMATION
"Confidential Information" means all non-public information disclosed by a Party, in any form, that is marked confidential or would reasonably be understood to be confidential.
2. OBLIGATIONS
Each Party shall keep the other Party's Confidential Information in strict confidence, use it only to evaluate and carry out the proposed relationship, and disclose it only to its employees and advisers who need to know it and are bound by equivalent duties.
3. EXCLUSIONS
These obligations do not apply to information that is or becomes public through no fault of the receiving Party, was lawfully known to it beforehand, or is independently developed.
4. TERM
This Agreement continues for two (2) years from its date, and the obligations of confidence survive for a further two (2) years.
5. RETURN OF MATERIALS
On written request, each Party shall promptly return or destroy the other Party's Confidential Information.
6. GOVERNING LAW
This Agreement is governed by the laws of [Jurisdiction], and the courts of [City] have exclusive jurisdiction.
Signed for ${client}: ____________________     Signed for ${other}: ____________________`,
    engagement: `LETTER OF ENGAGEMENT
${date}
Dear ${person},
Thank you for instructing us. This letter confirms the terms on which we will act for ${client}.
1. SCOPE OF WORK
We will advise on and prepare the documents for the matter described as "${ctx.title || '[Matter]'}". Work outside this scope will be agreed in writing first.
2. RESPONSIBILITY
${lawyer} will have overall responsibility for your matter, assisted by members of our team.
3. FEES AND BILLING
Our fees are charged on the basis of time spent at our standard hourly rates, plus expenses. We will invoice monthly; invoices are payable within thirty (30) days.
4. CONFIDENTIALITY
We will keep your affairs confidential, subject to our legal and regulatory obligations.
5. TERMINATION
You may end our engagement at any time by written notice. We may stop acting where permitted by our professional rules.
Please sign and return a copy of this letter to confirm your agreement.
Yours sincerely,
${lawyer}
Agreed for ${client}: ____________________`,
    services: `SERVICES AGREEMENT
This Services Agreement is made on ${date} between ${client} (the "Customer") and ${other} (the "Supplier").
1. SERVICES
The Supplier shall provide the services described in Schedule 1 (the "Services") with reasonable skill and care.
2. FEES
The Customer shall pay the fees set out in Schedule 2 within thirty (30) days of a valid invoice.
3. TERM AND TERMINATION
This Agreement starts on its date and continues for twelve (12) months. Either party may terminate on thirty (30) days' written notice, or immediately for material breach not remedied within fourteen (14) days.
4. INTELLECTUAL PROPERTY
Each party keeps its existing intellectual property. Deliverables created specifically for the Customer belong to the Customer on payment.
5. LIABILITY
Neither party's total liability shall exceed the fees paid in the twelve (12) months before the claim, except for liability that cannot lawfully be limited.
6. GOVERNING LAW
This Agreement is governed by the laws of [Jurisdiction].
Signed for the Customer: ____________________     Signed for the Supplier: ____________________`,
    employment: `EMPLOYMENT AGREEMENT
This Employment Agreement is made on ${date} between ${client} (the "Company") and ${other} (the "Employee").
1. POSITION
The Employee is employed as [Job title], reporting to [Manager], starting on [Start date].
2. DUTIES
The Employee shall perform the duties reasonably assigned by the Company and devote their full working time to the business.
3. REMUNERATION
The Company shall pay a salary of [Amount] per year, payable monthly in arrears.
4. HOURS AND LEAVE
Normal working hours are [Hours]. The Employee is entitled to [Number] working days of paid leave each year.
5. CONFIDENTIALITY
The Employee shall not disclose the Company's confidential information during or after employment.
6. TERMINATION
Either party may end employment by giving [Notice period] written notice.
Signed for the Company: ____________________     Employee: ____________________`,
    lease: `COMMERCIAL LEASE AGREEMENT
This Lease is made on ${date} between ${other} (the "Landlord") and ${client} (the "Tenant").
1. PREMISES
The Landlord lets to the Tenant the premises at [Address] (the "Premises").
2. TERM
The lease runs for [Number] years from [Start date].
3. RENT
The Tenant shall pay rent of [Amount] per month, in advance on the first day of each month.
4. SECURITY DEPOSIT
The Tenant shall pay a security deposit equal to [Number] months' rent, refundable at the end of the lease less any lawful deductions.
5. USE AND REPAIR
The Tenant shall use the Premises only as offices and keep the interior in good repair.
6. TERMINATION
Either party may end this lease as permitted by law or by [Notice period] written notice.
Landlord: ____________________     Tenant: ____________________`,
    poa: `POWER OF ATTORNEY
I, ${person}, of [Address], appoint ${other} of [Address] as my attorney.
1. POWERS
My attorney may act for me in [Describe the matters], including signing documents and dealing with any authority on my behalf.
2. DURATION
This Power of Attorney takes effect on ${date} and remains in force until revoked by me in writing.
3. RATIFICATION
I agree to ratify everything my attorney lawfully does under this Power of Attorney.
Signed: ____________________     Date: ${date}
Witness: ____________________`,
    notice: `LEGAL NOTICE
${date}
To: ${other}
On behalf of our client, ${client}, we write regarding ${ctx.title || '[the matter]'}.
1. BACKGROUND
[Set out the relevant facts.]
2. CLAIM
[Set out what our client requires and the legal basis.]
3. REQUIRED ACTION
You are required to [action] within fourteen (14) days of this notice, failing which our client may take further action without further notice to you.
Yours faithfully,
${lawyer}
For and on behalf of ${client}`,
  };
  return T[id] ?? T.blank;
}

module.exports = { TEMPLATES, render };
