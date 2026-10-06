// The example documents. Everything in them is invented: the companies, the people, the numbers.
import { right, writePdf } from './pdf-writer.mjs';

/** Cents as printed money: 128436 -> "1,284.36". */
const money = (cents) =>
  `${Math.trunc(cents / 100).toLocaleString('en-US')}.${String(cents % 100).padStart(2, '0')}`;

// --- 1. A freight invoice: a two-page table, two lines per consignment ---------------------------

const RECEIVERS = [
  ['Acme Trading Co', 'Port Melbourne VIC'],
  ['Blue Gum Books', 'Geelong VIC'],
  ['Corner Hardware', 'Ballarat VIC'],
  ['Delta Dental Supply', 'Parramatta NSW'],
  ['Eastside Cycles', 'Newcastle NSW'],
  ['Fern & Feather', 'Hobart TAS'],
  ['Granite Kitchens', 'Toowoomba QLD'],
];
const SERVICES = ['Express', 'Road', 'Overnight'];

/** 29 consignments, the same every time. `misprint` adds $10 to one freight figure and nothing else. */
function consignments(misprint) {
  return Array.from({ length: 29 }, (_, i) => {
    const kg = 4 + ((i * 37) % 180) + (i % 2) / 2;
    const freight = 1850 + ((i * 7919) % 26000);
    const fuel = Math.round(freight * 0.12);
    return {
      date: `${String(3 + i).padStart(2, '0')}/08/2026`,
      conNote: `NF${10045800 + i * 7}`,
      receiver: RECEIVERS[i % RECEIVERS.length],
      service: SERVICES[i % SERVICES.length],
      kg: kg.toFixed(1),
      freight: freight + (misprint && i === 6 ? 1000 : 0),
      fuel,
      total: freight + fuel,
    };
  });
}

const HEADING = (y) => [
  { x: 40, y, text: 'Date', bold: true },
  { x: 108, y, text: 'Con Note', bold: true },
  { x: 175, y, text: 'Receiver', bold: true },
  { x: 300, y, text: 'Service', bold: true },
  { x: 382, y, text: 'Kg', bold: true },
  { x: 419, y, text: 'Freight', bold: true },
  { x: 469, y, text: 'Fuel Levy', bold: true },
  { x: 537, y, text: 'Total', bold: true },
];

const consignment = (c, y) => [
  { x: 40, y, text: c.date },
  { x: 108, y, text: c.conNote },
  { x: 175, y, text: c.receiver[0] },
  { x: 300, y, text: c.service },
  right(395, y, c.kg),
  right(450, y, money(c.freight)),
  right(510, y, money(c.fuel)),
  right(560, y, money(c.total)),
  { x: 175, y: y + 11, text: c.receiver[1] },
];

export function freightInvoice({ misprint = false } = {}) {
  const all = consignments(misprint);
  const [first, second] = [all.slice(0, 20), all.slice(20)];
  const sum = (list) => list.reduce((total, c) => total + c.total, 0);
  const subtotal = sum(all);
  const gst = Math.round(subtotal * 0.1);
  const page1 = [
    { x: 40, y: 60, text: 'NORTHWIND FREIGHT', size: 16, bold: true },
    { x: 40, y: 78, text: '14 Dockside Avenue, Port Melbourne VIC 3207' },
    { x: 400, y: 60, text: 'TAX INVOICE', size: 12, bold: true },
    { x: 400, y: 78, text: 'Invoice No: NF-104512' },
    { x: 400, y: 90, text: 'Invoice Date: 31/08/2026' },
    { x: 40, y: 120, text: 'Bill To: Kestrel Outdoor Supplies' },
    { x: 40, y: 132, text: 'Account: KES-0042' },
    ...HEADING(170),
    ...first.flatMap((c, i) => consignment(c, 190 + i * 26)),
    { x: 380, y: 730, text: 'Carried forward' },
    right(560, 730, money(sum(first))),
    { x: 40, y: 800, text: 'Page 1 of 2' },
  ];
  const totalsAt = 110 + second.length * 26 + 20;
  const page2 = [
    { x: 40, y: 50, text: 'NORTHWIND FREIGHT' },
    { x: 400, y: 50, text: 'Invoice No: NF-104512' },
    ...HEADING(70),
    { x: 380, y: 88, text: 'Brought forward' },
    right(560, 88, money(sum(first))),
    ...second.flatMap((c, i) => consignment(c, 110 + i * 26)),
    { x: 420, y: totalsAt, text: 'Subtotal' },
    right(560, totalsAt, money(subtotal)),
    { x: 420, y: totalsAt + 13, text: 'GST 10%' },
    right(560, totalsAt + 13, money(gst)),
    { x: 420, y: totalsAt + 26, text: 'Total AUD', bold: true },
    right(560, totalsAt + 26, money(subtotal + gst), { bold: true }),
    { x: 40, y: totalsAt + 70, text: 'Payment terms: 30 days from invoice date.' },
    { x: 40, y: 800, text: 'Page 2 of 2' },
  ];
  return writePdf([page1, page2]);
}

// --- 2. A courier statement: no table at all, each job a block of labelled lines -----------------

const JOBS = [
  {
    no: 'HC-20418',
    date: '03/09/2026',
    pickup: ['Acme Trading Co', '12 Wharf Rd, Port Melbourne'],
    delivery: ['Blue Gum Books', '8 Station St, Geelong'],
    charges: [['Base charge', 4200], ['Fuel surcharge 12%', 504], ['Waiting time', 1500]],
  },
  {
    no: 'HC-20431',
    date: '09/09/2026',
    pickup: ['Corner Hardware', '3 Mill Lane, Ballarat'],
    delivery: ['Kestrel Outdoor Supplies', '77 Ridge Rd, Bendigo'],
    charges: [['Base charge', 6850], ['Fuel surcharge 12%', 822]],
  },
  {
    no: 'HC-20447',
    date: '16/09/2026',
    pickup: ['Kestrel Outdoor Supplies', '77 Ridge Rd, Bendigo'],
    delivery: ['Eastside Cycles', '41 Harbour St, Newcastle'],
    charges: [['Base charge', 12400], ['Fuel surcharge 12%', 1488], ['After hours delivery', 3500]],
  },
  {
    no: 'HC-20460',
    date: '24/09/2026',
    pickup: ['Fern & Feather', '5 Salamanca Pl, Hobart'],
    delivery: ['Kestrel Outdoor Supplies', '77 Ridge Rd, Bendigo'],
    charges: [['Base charge', 9900], ['Fuel surcharge 12%', 1188], ['Tail lift', 2750], ['Waiting time', 750]],
  },
];

export function courierStatement() {
  const texts = [
    { x: 40, y: 60, text: 'HARBOUR COURIERS', size: 16, bold: true },
    { x: 40, y: 80, text: 'Statement of jobs for Kestrel Outdoor Supplies' },
    { x: 40, y: 92, text: 'Statement date: 30/09/2026' },
  ];
  let y = 130;
  let due = 0;
  for (const job of JOBS) {
    const total = job.charges.reduce((sum, [, cents]) => sum + cents, 0);
    due += total;
    texts.push(
      { x: 40, y, text: 'Job No:', bold: true },
      { x: 110, y, text: job.no },
      { x: 320, y, text: 'Date:', bold: true },
      { x: 390, y, text: job.date },
      { x: 40, y: y + 12, text: 'Pickup:', bold: true },
      { x: 110, y: y + 12, text: job.pickup[0] },
      { x: 320, y: y + 12, text: 'Delivery:', bold: true },
      { x: 390, y: y + 12, text: job.delivery[0] },
      { x: 110, y: y + 24, text: job.pickup[1] },
      { x: 390, y: y + 24, text: job.delivery[1] },
    );
    y += 40;
    for (const [name, cents] of job.charges) {
      texts.push({ x: 60, y, text: name }, right(300, y, money(cents)));
      y += 12;
    }
    texts.push({ x: 60, y, text: 'Job total', bold: true }, right(300, y, money(total), { bold: true }));
    y += 32;
  }
  texts.push({ x: 60, y, text: 'Total due', bold: true }, right(300, y, money(due), { bold: true }));
  return writePdf([texts]);
}
