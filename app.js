/* =========================================================================
   MFC Invoice System — AP eConnect Multi-Upload Builder
   Pure client-side (no backend). All state lives in the browser (localStorage).
   ========================================================================= */

/* ---------------------- Constants: Nokia Submit template ---------------------- */
const HDR_LABELS = [
  "Document Type (Invoice/Credit Note)", "Invoice Reference", "Supplier ID", "Supplier Name",
  "Supplier VAT ID", "Company Code", "Customer Name", "Customer VAT ID",
  "Invoice Date (use YYYY-MM-DD format)", "Currency", "Payment Reference", "Bank Account",
  "Original Invoice Number (Credit Notes)", "Target System", "Payment Terms"
];
const LINE_LABELS = [
  "Purchase Order Number", "PO Line Item Number", "Description", "Unit", "Quantity",
  "Net Unit Price", "PO Currency", "Net Unit Price Per", "Net Amount", "VAT %",
  "VAT Amount (Fill only % or amount)", "Calculated VAT Amount", "Gross Amount",
  "Delivery Note", "Buyer Material Code", "Material/Service", "PO Target System",
  "PO Payment Terms", "Shipped from Country", "Shipped to Country"
];

/* ---------------------- App state ---------------------- */
let state = {
  dumpRows: [],       // parsed+filtered available line items
  dumpRawCount: 0,
  excludedCount: 0,
  invoiceMap: {},      // normalizedPO -> {site, invoiceNumber}
  mapRawCount: 0,
  invoices: [],        // built invoice objects
};

/* ---------------------- Utilities ---------------------- */
function toast(msg){
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(()=>t.classList.remove('show'), 2600);
}

function normPO(po){
  if(po===undefined||po===null) return '';
  let s = String(po).trim();
  // strip leading zeros, keep only digits if possible
  let digits = s.replace(/[^0-9]/g,'');
  if(digits.length) return String(parseInt(digits,10));
  return s.toUpperCase();
}

function parseNum(v){
  if(v===undefined||v===null||v==='') return 0;
  if(typeof v === 'number') return v;
  let s = String(v).replace(/,/g,'').trim();
  let n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parseBool(v){
  if(typeof v === 'boolean') return v;
  return String(v).trim().toUpperCase() === 'TRUE';
}

function todayISO(){
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${yyyy}-${mm}-${dd}`;
}

function fmtNum(n){
  return n.toLocaleString('en-US', {minimumFractionDigits:0, maximumFractionDigits:2});
}

/* ---------------------- Generic table parsing (paste or file) ---------------------- */
function parseDelimitedText(text){
  // Splits on tabs primarily; falls back to comma if no tabs found.
  const lines = text.replace(/\r/g,'').split('\n').filter(l=>l.trim().length>0);
  if(lines.length===0) return {headers:[], rows:[]};
  const delim = lines[0].includes('\t') ? '\t' : ',';
  const headers = lines[0].split(delim).map(h=>h.trim());
  const rows = lines.slice(1).map(line=>{
    const cells = line.split(delim);
    const obj = {};
    headers.forEach((h,i)=> obj[h] = (cells[i]!==undefined? cells[i].trim() : ''));
    return obj;
  });
  return {headers, rows};
}

function parseWorkbookFile(file, callback){
  const reader = new FileReader();
  reader.onload = function(e){
    try{
      const data = new Uint8Array(e.target.result);
      const wb = XLSX.read(data, {type:'array'});
      const firstSheet = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json(firstSheet, {defval:'', raw:false});
      // Convert to same shape as parseDelimitedText: headers + rows(as objects)
      const headers = json.length ? Object.keys(json[0]) : [];
      callback({headers, rows: json});
    }catch(err){
      toast('تعذّر قراءة الملف: '+err.message);
    }
  };
  reader.readAsArrayBuffer(file);
}

function findKey(headers, candidates){
  for(const cand of candidates){
    const hit = headers.find(h => h.trim().toLowerCase() === cand.toLowerCase());
    if(hit) return hit;
  }
  // fuzzy contains match
  for(const cand of candidates){
    const hit = headers.find(h => h.trim().toLowerCase().includes(cand.toLowerCase()));
    if(hit) return hit;
  }
  return null;
}

/* ---------------------- Step 1: PO Dump parsing ---------------------- */
function processDump(headers, rows){
  const key = {
    po: findKey(headers, ['Purchase Order Number','PO Number','PO#']),
    item: findKey(headers, ['Item No','PO Line Item Number','Item Number']),
    desc: findKey(headers, ['Item Description','Description']),
    unit: findKey(headers, ['Unit']),
    qtyOpen: findKey(headers, ['Quantity Open']),
    price: findKey(headers, ['Net Unit Price']),
    priceUnit: findKey(headers, ['Net Unit Price Per']),
    currency: findKey(headers, ['Currency']),
    selfBilling: findKey(headers, ['Is Self Billing']),
    deletedBlocked: findKey(headers, ['Deleted/Blocked','Deleted or Blocked']),
    supplierId: findKey(headers, ['Supplier P20/BP Id','Supplier ID']),
    supplierName: findKey(headers, ['Supplier','Supplier Name']),
    customer: findKey(headers, ['Customer','Customer Name']),
    customerVat: findKey(headers, ['Customer VAT','Customer VAT ID']),
    paymentTerms: findKey(headers, ['Payment Terms']),
    targetSystem: findKey(headers, ['Target System']),
    buyerMatCode: findKey(headers, ['Buyer Material Code']),
  };

  if(!key.po || !key.item){
    toast('تعذّر التعرف على أعمدة الملف — تحقق من أسماء الأعمدة');
    return null;
  }

  let available = [];
  let excluded = 0;

  rows.forEach(r=>{
    const po = r[key.po];
    if(po===undefined || po===null || String(po).trim()==='') return;
    const selfBilling = key.selfBilling ? parseBool(r[key.selfBilling]) : false;
    const deletedBlocked = key.deletedBlocked ? parseBool(r[key.deletedBlocked]) : false;
    const qtyOpen = key.qtyOpen ? parseNum(r[key.qtyOpen]) : 0;

    if(selfBilling || deletedBlocked || qtyOpen<=0){
      excluded++;
      return;
    }

    available.push({
      poRaw: po,
      poNorm: normPO(po),
      itemNo: key.item ? r[key.item] : '',
      description: key.desc ? r[key.desc] : '',
      unit: key.unit ? r[key.unit] : 'PCE',
      quantityOpen: qtyOpen,
      netUnitPrice: key.price ? parseNum(r[key.price]) : 0,
      netUnitPricePer: key.priceUnit ? parseNum(r[key.priceUnit]) || 1 : 1,
      currency: key.currency ? r[key.currency] : 'IQD',
      supplierId: key.supplierId ? r[key.supplierId] : '',
      supplierName: key.supplierName ? r[key.supplierName] : '',
      customer: key.customer ? r[key.customer] : '',
      customerVat: key.customerVat ? r[key.customerVat] : '',
      paymentTerms: key.paymentTerms ? r[key.paymentTerms] : '',
      targetSystem: key.targetSystem ? r[key.targetSystem] : '',
      buyerMaterialCode: key.buyerMatCode ? r[key.buyerMatCode] : '',
    });
  });

  return {available, excluded, totalRows: rows.length};
}

function handleDumpParse(){
  const text = document.getElementById('dumpText').value.trim();
  const fileInput = document.getElementById('dumpFile');

  function finish(headers, rows){
    const result = processDump(headers, rows);
    if(!result) return;
    state.dumpRows = result.available;
    state.dumpRawCount = result.totalRows;
    state.excludedCount = result.excluded;
    renderDumpStats();
    autoSave();
    toast('تم تحليل بيانات الـPO بنجاح ✓');
  }

  if(fileInput.files && fileInput.files[0]){
    parseWorkbookFile(fileInput.files[0], ({headers, rows})=> finish(headers, rows));
  } else if(text){
    const {headers, rows} = parseDelimitedText(text);
    finish(headers, rows);
  } else {
    toast('الصق البيانات أو ارفع ملف أولاً');
  }
}

function renderDumpStats(){
  const poSet = new Set(state.dumpRows.map(r=>r.poNorm));
  document.getElementById('dumpStats').style.display='grid';
  document.getElementById('stRows').textContent = state.dumpRawCount;
  document.getElementById('stAvail').textContent = state.dumpRows.length;
  document.getElementById('stExcluded').textContent = state.excludedCount;
  document.getElementById('stPOs').textContent = poSet.size;
  const badge = document.getElementById('dumpBadge');
  if(state.dumpRows.length){
    badge.textContent = poSet.size + ' فاتورة جاهزة للبناء';
    badge.className = 'badge good';
    markStepDone(1);
  } else {
    badge.textContent = 'لا توجد بنود متاحة';
    badge.className = 'badge bad';
  }
}

/* ---------------------- Step 2: Invoice reference mapping ---------------------- */
function processMap(headers, rows){
  const key = {
    po: findKey(headers, ['PO#','PO Number','Purchase Order Number']),
    site: findKey(headers, ['Site']),
    invNum: findKey(headers, ['Invoice Number','Invoice Reference']),
  };
  if(!key.po || !key.invNum){
    toast('تعذّر التعرف على أعمدة جدول الفواتير — تحقق من الأسماء (Site / PO# / Invoice Number)');
    return null;
  }
  const map = {};
  rows.forEach(r=>{
    const po = r[key.po];
    if(po===undefined || String(po).trim()==='') return;
    map[normPO(po)] = {
      site: key.site ? r[key.site] : '',
      invoiceNumber: r[key.invNum],
    };
  });
  return {map, count: rows.length};
}

function handleMapParse(){
  const text = document.getElementById('mapText').value.trim();
  const fileInput = document.getElementById('mapFile');

  function finish(headers, rows){
    const result = processMap(headers, rows);
    if(!result) return;
    state.invoiceMap = result.map;
    state.mapRawCount = result.count;
    renderMapStats();
    autoSave();
    toast('تم تحليل جدول أرقام الفواتير بنجاح ✓');
  }

  if(fileInput.files && fileInput.files[0]){
    parseWorkbookFile(fileInput.files[0], ({headers, rows})=> finish(headers, rows));
  } else if(text){
    const {headers, rows} = parseDelimitedText(text);
    finish(headers, rows);
  } else {
    toast('الصق الجدول أو ارفع ملف أولاً');
  }
}

function renderMapStats(){
  document.getElementById('mapStats').style.display='grid';
  const poSet = new Set(state.dumpRows.map(r=>r.poNorm));
  const mapKeys = Object.keys(state.invoiceMap);
  const matched = mapKeys.filter(k=>poSet.has(k)).length;
  document.getElementById('stMapRows').textContent = state.mapRawCount;
  document.getElementById('stMapMatched').textContent = matched;
  document.getElementById('stMapUnmatched').textContent = mapKeys.length - matched;
  const badge = document.getElementById('mapBadge');
  if(mapKeys.length){
    badge.textContent = matched + ' مطابقة';
    badge.className = 'badge good';
    markStepDone(2);
  }
}

/* ---------------------- Step 3->4: Build invoices ---------------------- */
function buildInvoices(){
  if(!state.dumpRows.length){
    toast('استورد بيانات الـPO أولاً (الخطوة 1)');
    return;
  }
  const vatPercent = parseNum(document.getElementById('vatPercent').value);
  const bankAccount = document.getElementById('bankAccount').value.trim();
  const companyCode = document.getElementById('companyCode').value.trim();
  const invoiceDate = todayISO();
  document.getElementById('invoiceDateDisplay').value = invoiceDate;

  // group by PO
  const groups = {};
  state.dumpRows.forEach(r=>{
    if(!groups[r.poNorm]) groups[r.poNorm] = [];
    groups[r.poNorm].push(r);
  });

  const invoices = Object.keys(groups).map(poNorm=>{
    const items = groups[poNorm];
    const first = items[0];
    const mapEntry = state.invoiceMap[poNorm];
    const lineItems = items.map(it=>{
      const netAmount = it.quantityOpen * it.netUnitPrice * it.netUnitPricePer;
      const calcVat = netAmount * (vatPercent/100);
      const gross = netAmount + calcVat;
      return {
        po: it.poRaw, itemNo: it.itemNo, description: it.description, unit: it.unit,
        quantity: it.quantityOpen, netUnitPrice: it.netUnitPrice, currency: it.currency,
        netUnitPricePer: it.netUnitPricePer, netAmount, vatPercent, vatAmount: 0,
        calcVat, gross, buyerMaterialCode: it.buyerMaterialCode,
        materialService: 'Material', targetSystem: it.targetSystem, paymentTerms: it.paymentTerms,
        shipFrom: 'IQ', shipTo: 'IQ',
      };
    });
    const totalNet = lineItems.reduce((s,x)=>s+x.netAmount,0);
    const totalVat = lineItems.reduce((s,x)=>s+x.calcVat,0);
    const totalGross = lineItems.reduce((s,x)=>s+x.gross,0);
    return {
      poNorm, poDisplay: first.poRaw,
      invoiceReference: mapEntry ? mapEntry.invoiceNumber : '',
      matched: !!mapEntry,
      site: mapEntry ? mapEntry.site : '',
      invoiceDate, bankAccount, companyCode,
      supplierId: first.supplierId, supplierName: first.supplierName,
      customer: first.customer, customerVat: first.customerVat,
      currency: first.currency, targetSystem: first.targetSystem, paymentTerms: first.paymentTerms,
      lineItems, totalNet, totalVat, totalGross,
    };
  });

  state.invoices = invoices;
  renderInvoices();
  autoSave();
}

function recalcVatOnly(){
  // live recompute without full rebuild, using current vatPercent input
  if(!state.invoices.length) return;
  const vatPercent = parseNum(document.getElementById('vatPercent').value);
  state.invoices.forEach(inv=>{
    let totalNet=0, totalVat=0, totalGross=0;
    inv.lineItems.forEach(li=>{
      li.vatPercent = vatPercent;
      li.calcVat = li.netAmount * (vatPercent/100);
      li.gross = li.netAmount + li.calcVat;
      totalNet += li.netAmount; totalVat += li.calcVat; totalGross += li.gross;
    });
    inv.totalNet=totalNet; inv.totalVat=totalVat; inv.totalGross=totalGross;
  });
  renderInvoices();
  autoSave();
}

function renderInvoices(){
  const list = document.getElementById('invoiceList');
  const empty = document.getElementById('emptyInvoices');
  list.innerHTML = '';
  if(!state.invoices.length){
    empty.style.display='block';
    document.getElementById('invBadge').textContent = '0 فاتورة';
    return;
  }
  empty.style.display='none';
  document.getElementById('invBadge').textContent = state.invoices.length + ' فاتورة';
  document.getElementById('invBadge').className = 'badge good';

  let sumLines=0, sumNet=0, sumVat=0, sumGross=0;
  let unmatchedCount = 0;

  state.invoices.forEach((inv, idx)=>{
    sumLines += inv.lineItems.length;
    sumNet += inv.totalNet; sumVat += inv.totalVat; sumGross += inv.totalGross;
    if(!inv.matched) unmatchedCount++;

    const div = document.createElement('div');
    div.className = 'invoice';
    div.innerHTML = `
      <div class="invoice-head" onclick="toggleInvoice(${idx})">
        <div class="left">
          <span class="po">PO ${inv.poDisplay}</span>
          <span class="ref">${inv.matched ? '📄 '+inv.invoiceReference : '<span style=\'color:var(--bad)\'>⚠ لا يوجد رقم فاتورة مطابق</span>'}</span>
          <span class="badge neutral">${inv.lineItems.length} بند</span>
        </div>
        <div class="left">
          <span class="amt">${fmtNum(inv.totalGross)} ${inv.currency}</span>
          <span class="chev">▾</span>
        </div>
      </div>
      <div class="invoice-body">
        <div class="hdr-fact">
          <span>Supplier ID: <b>${inv.supplierId}</b></span>
          <span>Customer: <b>${inv.customer}</b></span>
          <span>Invoice Date: <b>${inv.invoiceDate}</b></span>
          <span>Bank Account: <b>${inv.bankAccount}</b></span>
          <span>Target System: <b>${inv.targetSystem}</b></span>
          <span>Payment Terms: <b>${inv.paymentTerms}</b></span>
        </div>
        <table class="mini">
          <thead><tr>
            <th>Item</th><th>Description</th><th>Qty</th><th>Unit Price</th>
            <th>Net Amount</th><th>VAT %</th><th>Calc VAT</th><th>Gross</th>
          </tr></thead>
          <tbody>
            ${inv.lineItems.map(li=>`
              <tr>
                <td>${li.itemNo}</td>
                <td>${li.description}</td>
                <td>${fmtNum(li.quantity)}</td>
                <td>${fmtNum(li.netUnitPrice)}</td>
                <td>${fmtNum(li.netAmount)}</td>
                <td>${li.vatPercent}%</td>
                <td>${fmtNum(li.calcVat)}</td>
                <td><b>${fmtNum(li.gross)}</b></td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    `;
    list.appendChild(div);
  });

  document.getElementById('sumInvoices').textContent = state.invoices.length;
  document.getElementById('sumLines').textContent = sumLines;
  document.getElementById('sumNet').textContent = fmtNum(sumNet);
  document.getElementById('sumVat').textContent = fmtNum(sumVat);
  document.getElementById('sumGross').textContent = fmtNum(sumGross);

  const warnDiv = document.getElementById('unmatchedWarning');
  if(unmatchedCount>0){
    warnDiv.innerHTML = `<div class="warn-list"><b>تنبيه:</b> يوجد ${unmatchedCount} فاتورة/فواتير بدون رقم مرجع مطابق من جدول الخطوة 2. تحقق من أرقام الـ PO في الجدولين.</div>`;
  } else {
    warnDiv.innerHTML = '';
  }
  markStepDone(4);
}

function toggleInvoice(idx){
  const nodes = document.querySelectorAll('#invoiceList .invoice');
  nodes[idx].classList.toggle('open');
}

/* ---------------------- Step 5: Export styled Excel ---------------------- */
async function exportExcel(){
  if(!state.invoices.length){
    toast('لا توجد فواتير للتصدير — أكمل بناء الفواتير أولاً');
    return;
  }
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Submit');

  const NAVY_LABEL_BG = 'FFB9D0EE';   // blue header label row
  const GREEN_LABEL_BG = 'FFC9E4CC';  // green line-item label row
  const YELLOW_BG = 'FFFFF6C9';       // mandatory-ish highlight

  function setRow(rowNum, values, bgHex, boldLabels){
    values.forEach((val, i)=>{
      const cell = ws.getCell(rowNum, i+1);
      cell.value = val;
      if(bgHex){
        cell.fill = {type:'pattern', pattern:'solid', fgColor:{argb:bgHex}};
      }
      if(boldLabels) cell.font = {bold:true, size:10};
      cell.alignment = {vertical:'middle'};
      cell.border = {bottom:{style:'thin', color:{argb:'FFE0E6EF'}}};
    });
  }

  let r = 1;
  state.invoices.forEach(inv=>{
    // Blue label row
    setRow(r, HDR_LABELS, NAVY_LABEL_BG, true);
    const hdrRow = r+1;
    // Header data row
    const hdrVals = [
      'Invoice', inv.invoiceReference || '', inv.supplierId, inv.supplierName,
      '', inv.companyCode, inv.customer, inv.customerVat,
      inv.invoiceDate, inv.currency, '', inv.bankAccount,
      '', inv.targetSystem, inv.paymentTerms
    ];
    setRow(hdrRow, hdrVals, null, false);
    // highlight editable/important cells
    [2,9,12].forEach(colIdx=>{
      ws.getCell(hdrRow, colIdx).fill = {type:'pattern', pattern:'solid', fgColor:{argb:YELLOW_BG}};
    });

    const lineLabelRow = hdrRow+1;
    setRow(lineLabelRow, LINE_LABELS, GREEN_LABEL_BG, true);

    let lr = lineLabelRow+1;
    inv.lineItems.forEach(li=>{
      const vals = [
        li.po, li.itemNo, li.description, li.unit, li.quantity,
        li.netUnitPrice, li.currency, li.netUnitPricePer, li.netAmount, li.vatPercent,
        0, li.calcVat, li.gross, '', li.buyerMaterialCode,
        li.materialService, li.targetSystem, li.paymentTerms, li.shipFrom, li.shipTo
      ];
      setRow(lr, vals, null, false);
      lr++;
    });
    r = lr + 1; // blank separator row
  });

  // Column widths
  const widths = [14,16,12,26,12,10,26,12,20,10,14,14,20,14,14,14,16,12,14,20,10,14,14,14,12,16,14,20,16,16];
  widths.forEach((w,i)=> ws.getColumn(i+1).width = w);

  ws.views = [{state:'frozen', ySplit:0}];

  const buf = await wb.xlsx.writeBuffer();
  const blob = new Blob([buf], {type:'application/octet-stream'});
  const fname = (document.getElementById('exportFileName').value.trim() || 'Multi-upload_PO_Invoices') + '.xlsx';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);

  document.getElementById('exportMsg').innerHTML = `<span class="badge good">✓ تم تنزيل ${fname}</span>`;
  toast('تم تصدير الملف بنجاح ✓');
}

/* ---------------------- Sessions (localStorage) ---------------------- */
const SESS_KEY = 'mfc_invoice_sessions_v1';
const AUTOSAVE_KEY = 'mfc_invoice_autosave_v1';

function currentSnapshot(){
  return {
    dumpText: document.getElementById('dumpText').value,
    mapText: document.getElementById('mapText').value,
    vatPercent: document.getElementById('vatPercent').value,
    bankAccount: document.getElementById('bankAccount').value,
    companyCode: document.getElementById('companyCode').value,
    dumpRows: state.dumpRows,
    dumpRawCount: state.dumpRawCount,
    excludedCount: state.excludedCount,
    invoiceMap: state.invoiceMap,
    mapRawCount: state.mapRawCount,
    invoices: state.invoices,
  };
}

function applySnapshot(snap){
  document.getElementById('dumpText').value = snap.dumpText || '';
  document.getElementById('mapText').value = snap.mapText || '';
  document.getElementById('vatPercent').value = snap.vatPercent ?? 0;
  document.getElementById('bankAccount').value = snap.bankAccount || '005673917711';
  document.getElementById('companyCode').value = snap.companyCode || 'FIIX';
  state.dumpRows = snap.dumpRows || [];
  state.dumpRawCount = snap.dumpRawCount || 0;
  state.excludedCount = snap.excludedCount || 0;
  state.invoiceMap = snap.invoiceMap || {};
  state.mapRawCount = snap.mapRawCount || 0;
  state.invoices = snap.invoices || [];
  renderDumpStats();
  renderMapStats();
  renderInvoices();
}

function autoSave(){
  try{
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(currentSnapshot()));
  }catch(e){ /* storage full or unavailable - ignore silently */ }
}

function restoreAutoSave(showToast){
  const raw = localStorage.getItem(AUTOSAVE_KEY);
  if(!raw) { if(showToast) toast('لا توجد جلسة سابقة محفوظة'); return; }
  try{
    applySnapshot(JSON.parse(raw));
    if(showToast) toast('تم استرجاع آخر جلسة عمل ✓');
  }catch(e){}
}

function getSessions(){
  try{ return JSON.parse(localStorage.getItem(SESS_KEY)) || []; }catch(e){ return []; }
}
function saveSessions(list){
  localStorage.setItem(SESS_KEY, JSON.stringify(list));
}

function saveNamedSession(){
  const nameInput = document.getElementById('sessionName');
  let name = nameInput.value.trim();
  if(!name){
    name = 'جلسة ' + new Date().toLocaleString('ar-IQ');
  }
  const sessions = getSessions();
  sessions.unshift({
    id: 'sess_'+Date.now(),
    name,
    savedAt: new Date().toLocaleString('ar-IQ'),
    snapshot: currentSnapshot(),
  });
  saveSessions(sessions);
  nameInput.value='';
  renderSessions();
  toast('تم حفظ الجلسة ✓');
}

function loadSession(id){
  const sessions = getSessions();
  const s = sessions.find(x=>x.id===id);
  if(!s) return;
  applySnapshot(s.snapshot);
  autoSave();
  toast('تم تحميل الجلسة: '+s.name);
  goStep(4);
}

function deleteSession(id){
  let sessions = getSessions();
  sessions = sessions.filter(x=>x.id!==id);
  saveSessions(sessions);
  renderSessions();
  toast('تم حذف الجلسة');
}

function renderSessions(){
  const sessions = getSessions();
  const list = document.getElementById('sessionsList');
  const empty = document.getElementById('emptySessions');
  list.innerHTML='';
  if(!sessions.length){ empty.style.display='block'; return; }
  empty.style.display='none';
  sessions.forEach(s=>{
    const nInv = (s.snapshot.invoices||[]).length;
    const div = document.createElement('div');
    div.className='session-item';
    div.innerHTML = `
      <div>
        <div><b>${s.name}</b></div>
        <div class="meta">${s.savedAt} · ${nInv} فاتورة</div>
      </div>
      <div class="actions">
        <button class="btn-secondary" onclick="loadSession('${s.id}')">فتح</button>
        <button class="btn-danger" onclick="deleteSession('${s.id}')">حذف</button>
      </div>`;
    list.appendChild(div);
  });
}

/* ---------------------- Navigation ---------------------- */
function goStep(n){
  document.querySelectorAll('.section').forEach(s=>s.classList.remove('active'));
  document.getElementById('sec'+n).classList.add('active');
  document.querySelectorAll('.step').forEach(s=>s.classList.remove('active'));
  document.querySelector(`.step[data-step="${n}"]`).classList.add('active');
  const titles = {
    1:['استيراد بيانات أوامر الشراء (PO Dump)','الصق أو ارفع ملف تصدير الـ PO الخام من AP eConnect (All Items export)'],
    2:['استيراد أرقام الفواتير (Invoice Reference)','اربط كل PO برقم فاتورته عبر جدول Site / PO# / Invoice Number'],
    3:['الإعدادات والضريبة','قيم ثابتة تُطبّق على كل الفواتير: البنك، كود الشركة، ونسبة الضريبة'],
    4:['المعاينة والفواتير','راجع كل فاتورة قبل التصدير — الحسابات تتحدث فوراً عند تغيير VAT%'],
    5:['تصدير الإكسل','نزّل ملف Multi-Upload جاهز للرفع في AP eConnect'],
    6:['الجلسات المحفوظة','احفظ عملك الحالي أو افتح عملية سابقة'],
  };
  document.getElementById('pageTitle').textContent = titles[n][0];
  document.getElementById('pageSub').textContent = titles[n][1];
  if(n===6) renderSessions();
  window.scrollTo({top:0, behavior:'smooth'});
}

function markStepDone(n){
  const el = document.querySelector(`.step[data-step="${n}"]`);
  if(el) el.classList.add('done');
}

/* ---------------------- Wire up events ---------------------- */
document.addEventListener('DOMContentLoaded', ()=>{
  document.getElementById('yearNow').textContent = new Date().getFullYear();
  document.getElementById('invoiceDateDisplay').value = todayISO();

  document.querySelectorAll('.step').forEach(el=>{
    el.addEventListener('click', ()=> goStep(el.dataset.step));
  });

  document.getElementById('btnParseDump').addEventListener('click', handleDumpParse);
  document.getElementById('btnClearDump').addEventListener('click', ()=>{
    document.getElementById('dumpText').value='';
    document.getElementById('dumpFile').value='';
    state.dumpRows=[]; state.dumpRawCount=0; state.excludedCount=0;
    document.getElementById('dumpStats').style.display='none';
    document.getElementById('dumpBadge').textContent='لم يتم الاستيراد بعد';
    document.getElementById('dumpBadge').className='badge neutral';
    autoSave();
  });

  document.getElementById('btnParseMap').addEventListener('click', handleMapParse);
  document.getElementById('btnClearMap').addEventListener('click', ()=>{
    document.getElementById('mapText').value='';
    document.getElementById('mapFile').value='';
    state.invoiceMap={}; state.mapRawCount=0;
    document.getElementById('mapStats').style.display='none';
    document.getElementById('mapBadge').textContent='لم يتم الاستيراد بعد';
    document.getElementById('mapBadge').className='badge neutral';
    autoSave();
  });

  document.getElementById('vatPercent').addEventListener('input', recalcVatOnly);
  document.getElementById('bankAccount').addEventListener('input', autoSave);
  document.getElementById('companyCode').addEventListener('input', autoSave);

  document.getElementById('btnExportExcel').addEventListener('click', exportExcel);

  document.getElementById('btnSaveSession').addEventListener('click', saveNamedSession);
  document.getElementById('btnSaveSessionTop').addEventListener('click', ()=> goStep(6));
  document.getElementById('btnAutoRestoreInfo').addEventListener('click', ()=> restoreAutoSave(true));

  // silent restore of last working state on load
  restoreAutoSave(false);
  renderSessions();
});
