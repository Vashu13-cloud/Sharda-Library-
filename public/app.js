const CAPACITY = 100;
const $ = id => document.getElementById(id);
const defaultSettings = { libraryName: 'Sharda Library', upiId: 'teenachoudhary186@ybl' };
const loadSettings = () => { try { return Object.assign({}, defaultSettings, JSON.parse(localStorage.getItem('shardha_settings') || '{}')); } catch { return Object.assign({}, defaultSettings); } };
let settings = loadSettings();
delete settings.adminUser; delete settings.adminPass; // remove legacy browser-stored credentials; authentication is server-side now
const loadStudents = () => { try { return JSON.parse(localStorage.getItem('shardha_students') || '[]'); } catch { return []; } };
let students = loadStudents();
let currentSeat = null;
const loadHalfVisits = () => { try { return JSON.parse(localStorage.getItem('shardha_half_time_visits') || '[]'); } catch { return []; } };
let halfVisits = loadHalfVisits();
const loadBookingRequests = () => { try { return JSON.parse(localStorage.getItem('sharda_booking_requests') || '[]'); } catch { return []; } };
let bookingRequests = loadBookingRequests();
let seatHistory = (()=>{try{return JSON.parse(localStorage.getItem('sharda_seat_history')||'[]');}catch{return [];}})();

let adminAuthenticated = false;
let dataSyncReady = false;
let dataSyncTimer = null;
let serverDataVersion = null;
function isAdminLoggedIn(){ return adminAuthenticated; }
function setAdminLoggedIn(val){ adminAuthenticated = Boolean(val); updateAuthUI(); }
async function loadServerDataOrMigrate(){
  dataSyncReady = false;
  const remote = await apiRequest('/api/data', { method: 'GET', headers: {} });
  serverDataVersion = remote.updatedAt || null;
  const remoteHasData = (remote.students||[]).length || (remote.halfVisits||[]).length || (remote.bookingRequests||[]).length || (remote.seatHistory||[]).length || (remote.settings?.libraryName && remote.settings.libraryName !== defaultSettings.libraryName) || (remote.settings?.upiId && remote.settings.upiId !== defaultSettings.upiId);
  const localHasData = students.length || halfVisits.length || bookingRequests.length || seatHistory.length || settings.libraryName !== defaultSettings.libraryName || settings.upiId !== defaultSettings.upiId;
  if (!remoteHasData && localHasData) {
    const migrate = confirm(`Existing data found in this browser:\n${students.length} students, ${halfVisits.length} half-time visits, ${bookingRequests.length} booking requests.\n\nImport this data into the server database now?`);
    if (migrate) { const saved = await apiRequest('/api/data', { method: 'PUT', body: JSON.stringify({ settings, students, halfVisits, bookingRequests, seatHistory, expectedUpdatedAt: serverDataVersion }) }); serverDataVersion=saved.updatedAt; adoptServerStudents(saved); }
  } else {
    students = remote.students || []; halfVisits = remote.halfVisits || []; bookingRequests = remote.bookingRequests || []; seatHistory = remote.seatHistory || [];
    settings = Object.assign({}, defaultSettings, remote.settings || {});
    safeSetItem('shardha_students', JSON.stringify(students));
    safeSetItem('shardha_half_time_visits', JSON.stringify(halfVisits));
    safeSetItem('sharda_booking_requests', JSON.stringify(bookingRequests));
    safeSetItem('sharda_seat_history', JSON.stringify(seatHistory));
    safeSetItem('shardha_settings', JSON.stringify(settings));
  }
  dataSyncReady = true; renderAll(); applySettings(); prepareNewStudentId();
}
function adoptServerStudents(saved){
  if(!saved||!Array.isArray(saved.students)||!students.some(student=>String(student.photo||'').startsWith('data:')))return;
  students=saved.students;
  try{localStorage.setItem('shardha_students',JSON.stringify(students));}catch{}
  renderAll();
}
function scheduleServerDataSave(){
  if (!adminAuthenticated || !dataSyncReady) return;
  clearTimeout(dataSyncTimer);
  dataSyncTimer = setTimeout(async()=>{
    try { const saved = await apiRequest('/api/data', { method: 'PUT', body: JSON.stringify({ settings, students, halfVisits, bookingRequests, seatHistory, expectedUpdatedAt: serverDataVersion }) }); serverDataVersion=saved.updatedAt; adoptServerStudents(saved); }
    catch(error) { dataSyncReady=false; toast('Server save stopped to protect data: ' + error.message + ' Sign out and sign in again to refresh.'); }
  }, 350);
}
async function apiRequest(path, options={}) {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(options.headers||{}) }, ...options });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
async function refreshAdminSession(){
  try { const data = await apiRequest('/api/auth/session', { method: 'GET', headers: {} }); setAdminLoggedIn(Boolean(data.authenticated)); }
  catch { setAdminLoggedIn(false); }
  if (isAdminLoggedIn()) { try { await loadServerDataOrMigrate(); go('dashboard'); } catch(error) { toast('Could not load server data: ' + error.message); go('public'); } } else { dataSyncReady=false; go('public'); }
}
function updateAuthUI(){
  const logged = isAdminLoggedIn();
  const pubGroup = document.querySelector('.public-nav-group');
  const admGroup = document.querySelector('.admin-nav-group');
  const topChip = $('topbarAdminChip');
  const topLogin = $('topbarLoginBtn');
  const topLogout = $('topbarLogoutBtn');
  const dot = $('authStatusDot');
  const txt = $('authStatusText');
  if(pubGroup) pubGroup.style.display = logged ? 'none' : 'block';
  if(admGroup) admGroup.style.display = logged ? 'block' : 'none';
  if(topChip) topChip.style.display = logged ? 'flex' : 'none';
  if(topLogin) topLogin.style.display = logged ? 'none' : 'inline-block';
  if(topLogout) topLogout.style.display = logged ? 'inline-block' : 'none';
  if(dot) dot.style.background = logged ? '#43d6a4' : '#f0a12c';
  if(txt) txt.textContent = logged ? 'Admin Workspace' : 'Visitor Mode';
}

function safeSetItem(key, val){
  try {
    localStorage.setItem(key, val);
    if(['shardha_students','shardha_half_time_visits','sharda_booking_requests','sharda_seat_history','shardha_settings'].includes(key)) scheduleServerDataSave();
    return true;
  } catch(e) {
    if(e && (e.name === 'QuotaExceededError' || e.code === 22 || e.code === 1014)) {
      toast('Storage full! Please export a JSON backup or remove some photos.');
    } else {
      toast('Error saving to browser storage.');
    }
    return false;
  }
}
function save(){ safeSetItem('shardha_students', JSON.stringify(students)); renderAll(); }
function isActive(s){ return s.membershipStatus !== 'Completed'; }
function nextStudentId(){ const year=new Date().getFullYear(); const prefix=`SL-${year}-`; const max=students.reduce((n,s)=>{const id=String(s.libraryId||s.roll||'');const m=id.match(new RegExp('^SL-'+year+'-(\\d+)$','i'));return m?Math.max(n,Number(m[1])):n;},0);return prefix+String(max+1).padStart(3,'0');}
function prepareNewStudentId(){ if(!$('studentId').value) $('studentRoll').value=nextStudentId(); }
function saveHalf(){ safeSetItem('shardha_half_time_visits', JSON.stringify(halfVisits)); renderAll(); }
function money(n){ return '₹' + Number(n||0).toLocaleString('en-IN'); }
function today(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function monthKey(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`; }
function datePlusMonth(date){ const d=new Date(date+'T00:00:00'); const day=d.getDate(); d.setDate(1); d.setMonth(d.getMonth()+1); const lastDay=new Date(d.getFullYear(),d.getMonth()+1,0).getDate(); d.setDate(Math.min(day,lastDay)); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function isRenewalDue(student){ return Boolean(student.dueDate && student.dueDate <= today()); }
function studentFeeLabel(student){ return isRenewalDue(student) ? 'Renewal Due' : student.feeStatus; }
function whatsappReminder(student){
 const phone=String(student.phone||'').replace(/\D/g,'');
 if(phone.length!==10){ toast('Please update this student’s 10-digit mobile number first.'); return; }
 const due=formatDateEnglish(student.dueDate);
 const libName=settings.libraryName||'Sharda Library';
 const upi=settings.upiId||'teenachoudhary186@ybl';
 const message=`Dear ${student.name},\n\nYour monthly membership at ${libName} has been completed${due ? ` on ${due}` : ''}. To continue using your allotted seat, kindly pay your monthly fee of ${money(student.monthlyFee)} and renew your membership.\n\nUPI ID: ${upi}\n\nThank you!\n${libName}`;
 window.open(`https://wa.me/91${phone}?text=${encodeURIComponent(message)}`,'_blank','noopener');
}
function escapeHTML(s=''){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toast(msg){ const t=$('toast'); t.textContent=msg; t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2600); }
function occupiedSeat(seat, exceptId=null){ return students.some(s=>isActive(s) && s.seat===seat && s.id!==exceptId); }
function freeSeats(){ return Array.from({length:CAPACITY},(_,i)=>String(i+1).padStart(2,'0')).filter(seat=>!occupiedSeat(seat)); }

const adminPages = ['dashboard', 'bookings', 'students', 'seats', 'fees', 'membership-expiry', 'records', 'halftime', 'settings'];
function go(page){
  if(page === 'bookings' && adminAuthenticated) { apiRequest('/api/data',{method:'GET',headers:{}}).then(data=>{ serverDataVersion=data.updatedAt||serverDataVersion; bookingRequests=data.bookingRequests||[]; dataSyncReady=true; safeSetItem('sharda_booking_requests',JSON.stringify(bookingRequests)); renderBookingRequests(); }).catch(error=>toast('Could not refresh booking requests: '+error.message)); }
  if(page === 'settings' && adminAuthenticated) loadServerTools();
  if(adminPages.includes(page) && !isAdminLoggedIn()){
    toast('Admin access required. Please log in.');
    page = 'login';
  }
  if(page === 'login' && isAdminLoggedIn()){
    page = 'dashboard';
  }
  document.querySelectorAll('.page').forEach(p=>p.classList.toggle('active',p.id==='page-'+page));
  document.querySelectorAll('.nav-link').forEach(b=>b.classList.toggle('active',b.dataset.page===page));
  if(innerWidth<=760)$('sidebar').classList.remove('open');
  if(page === 'public') renderPublicDashboard();
  renderAll();
}
document.querySelectorAll('[data-page]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.page)));
document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));
$('menuBtn').addEventListener('click',()=>{ if(innerWidth<=760)$('sidebar').classList.toggle('open'); else $('sidebar').classList.toggle('collapsed'); });
$('todayDate').textContent=new Date().toLocaleDateString('en-IN',{weekday:'short',day:'2-digit',month:'short',year:'numeric'});
$('year').textContent=new Date().getFullYear();
$('joiningDate').value=today();
function formatDateEnglish(iso){
 if(!iso) return '';
 const d=new Date(iso+'T00:00:00');
 const day=d.getDate();
 const suffix=(day%100>=11 && day%100<=13)?'th':({1:'st',2:'nd',3:'rd'}[day%10]||'th');
 const month=d.toLocaleDateString('en-US',{month:'short'});
 return `${day}${suffix} ${month} ${d.getFullYear()}`;
}
function syncJoiningDateDisplay(){ $('joiningDateDisplay').value=formatDateEnglish($('joiningDate').value); }
syncJoiningDateDisplay();
$('joiningDateBtn').addEventListener('click',()=>{ const picker=$('joiningDate'); if(picker.showPicker) picker.showPicker(); else picker.click(); });
$('joiningDateDisplay').addEventListener('click',()=>{ const picker=$('joiningDate'); if(picker.showPicker) picker.showPicker(); else picker.click(); });
$('joiningDate').addEventListener('change',syncJoiningDateDisplay);

function renderSeatOptions(selected=''){ const sel=$('studentSeat'); const free=freeSeats(); sel.innerHTML='<option value="">Choose a seat</option>'+free.map(n=>`<option value="${n}" ${n===selected?'selected':''}>Seat ${n}</option>`).join('')+(selected&&!free.includes(selected)?`<option value="${selected}" selected>Seat ${selected} (current)</option>`:''); }
function dateOffsetISO(offset){const d=new Date();d.setHours(0,0,0,0);d.setDate(d.getDate()+offset);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function getExpiryStudents(category){
 const start=today(), tomorrow=dateOffsetISO(1), fifthDay=dateOffsetISO(5);
 return students.filter(s=>{
  if(!isActive(s)||!s.dueDate)return false;
  if(category==='overdue')return s.dueDate<start;
  if(category==='today')return s.dueDate===start;
  if(category==='tomorrow')return s.dueDate===tomorrow;
  if(category==='next5')return s.dueDate>tomorrow&&s.dueDate<=fifthDay;
  return false;
 }).sort((a,b)=>String(a.dueDate).localeCompare(String(b.dueDate))||String(a.name).localeCompare(String(b.name)));
}
const expiryCategoryInfo={overdue:{title:'Overdue Students',description:'Membership has expired. Their seats remain blocked until the admin explicitly renews or ends membership.'},today:{title:'Expires Today',description:'Students whose membership expires today. Admin can renew membership or explicitly end it and release the seat.'},tomorrow:{title:'Expires Tomorrow',description:'Students whose membership expiry date is tomorrow.'},next5:{title:'Next 5 Days',description:'Students expiring after tomorrow and within the next five calendar days.'}};
function openExpiryStudents(category){
 const info=expiryCategoryInfo[category];if(!info)return;
 const list=getExpiryStudents(category);$('expiryModalTitle').textContent=`${info.title} (${list.length})`;$('expiryModalDescription').textContent=info.description;
 $('expiryStudentsTable').innerHTML=list.length?list.map(s=>{
  const actionable=s.dueDate<=today();
  const managementActions=actionable?`<button class="action-btn" type="button" data-expiry-renew="${escapeHTML(s.id)}">Renew Membership</button><button class="action-btn danger" type="button" data-expiry-end="${escapeHTML(s.id)}">End Membership</button>`:'';
  return `<tr><td><b>${escapeHTML(s.name)}</b></td><td>${escapeHTML(s.libraryId||s.roll||'—')}</td><td>${escapeHTML(s.phone||'—')}</td><td>${escapeHTML(s.seat||'—')}</td><td>${escapeHTML(formatDateEnglish(s.dueDate))}</td><td>${money(s.monthlyFee)}</td><td><div class="expiry-row-actions"><button class="action-btn" type="button" data-expiry-edit="${escapeHTML(s.id)}">View / Edit</button>${managementActions}</div></td></tr>`;
 }).join(''):'<tr><td colspan="7" class="empty-row">No students in this category.</td></tr>';
 $('expiryStudentsModal').classList.add('show');
 document.querySelectorAll('[data-expiry-edit]').forEach(button=>button.addEventListener('click',()=>{const id=button.dataset.expiryEdit;$('expiryStudentsModal').classList.remove('show');editStudent(id);}));
 document.querySelectorAll('[data-expiry-renew]').forEach(button=>button.addEventListener('click',()=>renewExpiredMembership(button.dataset.expiryRenew,category)));
 document.querySelectorAll('[data-expiry-end]').forEach(button=>button.addEventListener('click',()=>endExpiredMembership(button.dataset.expiryEnd,category)));
}
function renewExpiredMembership(id,category){
 const student=students.find(item=>item.id===id);
 if(!student||!isActive(student)||!student.dueDate||student.dueDate>today())return;
 const amount=money(student.monthlyFee);
 if(!confirm(`Confirm that ${student.name} has paid ${amount} and renew their membership for one month? Their current seat will remain assigned.`))return;
 student.feeStatus='Paid';
 student.paidMonth=monthKey();
 student.lastPaid=today();
 student.dueDate=datePlusMonth(today());
 student.membershipRenewedAt=new Date().toISOString();
 save();
 openExpiryStudents(category);
 toast(`${student.name}'s membership renewed. Seat ${student.seat||'—'} remains assigned.`);
}
function endExpiredMembership(id,category){
 const student=students.find(item=>item.id===id);
 if(!student||!isActive(student)||!student.dueDate||student.dueDate>today())return;
 const releasedSeat=student.seat||'';
 if(!confirm(`End ${student.name}'s membership? Their student record will remain in Former Student History and ${releasedSeat?`seat ${releasedSeat} will become available`:'no seat is currently assigned'}. This action cannot be undone automatically.`))return;
 student.membershipStatus='Completed';
 student.membershipEndedAt=new Date().toISOString();
 student.seat='';
 save();
 openExpiryStudents(category);
 toast(`${student.name}'s membership ended. ${releasedSeat?`Seat ${releasedSeat} is now available.`:'Student history preserved.'}`);
}
document.querySelectorAll('[data-expiry-category]').forEach(button=>button.addEventListener('click',()=>openExpiryStudents(button.dataset.expiryCategory)));
$('closeExpiryModal')?.addEventListener('click',()=>$('expiryStudentsModal').classList.remove('show'));
$('expiryStudentsModal')?.addEventListener('click',e=>{if(e.target===$('expiryStudentsModal'))$('expiryStudentsModal').classList.remove('show');});
function renderDashboard(){
 const active=students.filter(isActive), occupied=active.filter(s=>s.seat).length, available=CAPACITY-occupied, pending=active.filter(s=>studentFeeLabel(s)!=='Paid').length;
 $('expiryOverdueCount').textContent=getExpiryStudents('overdue').length;
 $('expiryTodayCount').textContent=getExpiryStudents('today').length;
 $('expiryTomorrowCount').textContent=getExpiryStudents('tomorrow').length;
 $('expiryNext5Count').textContent=getExpiryStudents('next5').length;
 $('totalStudents').textContent=students.length; $('activeStudents').textContent=active.length; $('formerStudents').textContent=students.length-active.length; $('occupiedSeats').textContent=occupied; $('availableSeats').textContent=available; $('pendingFees').textContent=pending;
 $('seatPercent').textContent=Math.round(occupied/CAPACITY*100)+'%'; $('seatDonut').style.background=`conic-gradient(#1769dc 0 ${occupied/CAPACITY*100}%,#e0e6f0 ${occupied/CAPACITY*100}% 100%)`;
 $('seatLegendOccupied').textContent=occupied; $('seatLegendAvailable').textContent=available;
 const paid=active.filter(s=>studentFeeLabel(s)==='Paid').length; $('paidCount').textContent=paid; $('pendingCount').textContent=pending;
 const collected=active.filter(s=>s.feeStatus==='Paid'&&s.paidMonth===monthKey()).reduce((a,s)=>a+Number(s.monthlyFee||0),0);
 $('feeCollected').textContent=money(collected);
}
function renderSeats(){
 const q=($('seatSearch').value||'').toLowerCase(); $('seatGrid').innerHTML=Array.from({length:CAPACITY},(_,i)=>{const seat=String(i+1).padStart(2,'0'),s=students.find(x=>isActive(x)&&x.seat===seat);const hay=(seat+' '+(s?.name||'')+' '+(s?.roll||'')).toLowerCase();if(q&&!hay.includes(q))return '';return `<button class="seat ${s?'occupied':''}" data-seat="${seat}">${seat}<small>${s?escapeHTML(s.name.split(' ')[0]):'Available'}</small></button>`}).join('');
 document.querySelectorAll('[data-seat]').forEach(b=>b.addEventListener('click',()=>showSeat(b.dataset.seat)));
}
function showSeat(seat){
 currentSeat=seat; const s=students.find(x=>isActive(x)&&x.seat===seat); $('seatModalTitle').textContent='Seat '+seat;
 $('seatModalText').textContent=s?`${s.name} (${s.roll}) is currently assigned to this seat.`:'This seat is available. You can assign it to a registered student.';
 const actions=$('seatModalActions'); actions.innerHTML='';
 if(s){ const edit=document.createElement('button');edit.className='btn-primary';edit.textContent='View student';edit.onclick=()=>{ $('seatModal').classList.remove('show');editStudent(s.id); };actions.append(edit);
 if(isRenewalDue(s)){
  const note=document.createElement('p');note.className='seat-blocked-note';note.textContent='Membership renewal is due. This seat stays blocked until the admin renews the membership or ends it from Membership Expiry.';actions.append(note);
 }else{
  const un=document.createElement('button');un.className='btn-light';un.textContent='Unassign seat';un.onclick=()=>{if(!confirm(`Unassign seat ${seat} from ${s.name}? The membership will remain active.`))return;s.seat='';save();$('seatModal').classList.remove('show');toast('Seat '+seat+' is now available.');};actions.append(un);
 }
 }else{const assign=document.createElement('button');assign.className='btn-primary';assign.textContent='Assign student';assign.onclick=()=>{ $('seatModal').classList.remove('show');go('students');renderSeatOptions(seat);$('studentSeat').value=seat; };actions.append(assign);}
}
$('closeSeatModal').onclick=()=>$('seatModal').classList.remove('show');$('seatModal').addEventListener('click',e=>{if(e.target===$('seatModal'))$('seatModal').classList.remove('show');});
function renderRecords(){
 const q=($('recordSearch').value||'').trim().toLowerCase();
 const type=$('recordTypeFilter')?.value||'all';
 const list=students.filter(s=>{
  const matchesType=type==='all'||(type==='active'&&isActive(s))||(type==='former'&&!isActive(s));
  const matchesSearch=(s.name+' '+(s.libraryId||s.roll)+' '+s.phone+' '+s.seat).toLowerCase().includes(q);
  return matchesType&&matchesSearch;
 });
 $('recordsTable').innerHTML=list.length?list.map(s=>`<tr><td>${s.photo?`<img class="record-photo" src="${s.photo}" alt="${escapeHTML(s.name)} photo">`:`<span class="student-avatar">${escapeHTML(s.name.charAt(0).toUpperCase())}</span>`}</td><td><div class="student-cell"><b>${escapeHTML(s.name)}</b></div><small>${escapeHTML(s.joining||'')}</small></td><td>${escapeHTML(s.libraryId||s.roll)}</td><td>${escapeHTML(s.phone)}</td><td>${escapeHTML(s.course||'—')}</td><td>${isActive(s)?(s.seat||'—'):'—'}</td><td><span class="status ${isActive(s)?'paid':'pending'}">${isActive(s)?'Active':'Completed / Left'}</span></td><td><span class="status ${studentFeeLabel(s)==='Paid'?'paid':'pending'}">${studentFeeLabel(s)}</span></td><td><button class="action-btn" data-receipt="${s.id}" title="Print Payment Receipt">Slip</button><button class="action-btn" data-edit="${s.id}">Edit</button>${isActive(s)?`<button class="action-btn danger" data-archive="${s.id}">Mark Left</button>`:`<button class="action-btn" data-reactivate="${s.id}">Reactivate</button>`}</td></tr>`).join(''):'<tr><td colspan="9" class="empty-row">No student records found.</td></tr>';
 document.querySelectorAll('#recordsTable [data-receipt]').forEach(b=>b.onclick=()=>showReceipt(b.dataset.receipt));
 document.querySelectorAll('[data-edit]').forEach(b=>b.onclick=()=>editStudent(b.dataset.edit));
 document.querySelectorAll('[data-archive]').forEach(b=>b.onclick=()=>changeMembership(b.dataset.archive,'Completed'));
 document.querySelectorAll('[data-reactivate]').forEach(b=>b.onclick=()=>changeMembership(b.dataset.reactivate,'Active'));
}
function changeMembership(id,status){const s=students.find(x=>x.id===id);if(!s)return;if(status==='Completed'&&!confirm(`Mark ${s.name} as Completed / Left? Their record will be kept, but their seat will be released.`))return;s.membershipStatus=status;if(status==='Completed')s.seat='';save();toast(status==='Completed'?'Student history saved and seat released.':'Student membership reactivated.');}

function showReceipt(id){
 const s=students.find(x=>x.id===id);
 if(!s)return;
 const modal=$('receiptModal');
 if(!modal)return;
 const recDateClean=(s.lastPaid||s.joining||today()).replace(/\D/g,'');
 const rollCode=String(s.libraryId||s.roll||'001').replace(/[^a-zA-Z0-9]/g,'').slice(-4).toUpperCase();
 const recNumber=`REC-${recDateClean}-${rollCode}`;
 
 $('receiptLibName').textContent=settings.libraryName||'Sharda Library';
 $('receiptNumber').textContent=recNumber;
 $('receiptStudentName').textContent=s.name;
 $('receiptStudentId').textContent=s.libraryId||s.roll;
 $('receiptSeatNumber').textContent=s.seat?`Seat ${s.seat}`:'Unassigned';
 $('receiptCourse').textContent=s.course||'General Study / Self Prep';
 $('receiptPhone').textContent=s.phone||'—';
 $('receiptPaymentDate').textContent=formatDateEnglish(s.lastPaid||s.joining||today());
 $('receiptFeeAmount').textContent=money(s.monthlyFee);
 $('receiptValidDate').textContent=formatDateEnglish(s.dueDate||datePlusMonth(s.lastPaid||today()));
 $('receiptUpiDisplay').textContent=settings.upiId||'teenachoudhary186@ybl';
 modal.classList.add('show');
}

function renderFees(){
 const q=($('feeSearch').value||'').toLowerCase();const list=students.filter(s=>isActive(s)&&(s.name+' '+(s.libraryId||s.roll)).toLowerCase().includes(q));
 $('feesTable').innerHTML=list.length?list.map(s=>{const due=isRenewalDue(s),label=studentFeeLabel(s),statusClass=due?'pending':String(s.feeStatus||'Pending').toLowerCase();return `<tr><td><b>${escapeHTML(s.name)}</b><br><small>${escapeHTML(s.roll)}</small></td><td>${s.seat||'—'}</td><td>${money(s.monthlyFee)}</td><td>${s.dueDate||'—'}</td><td><span class="status ${statusClass}">${label}</span></td><td><button class="action-btn" data-receipt="${s.id}" title="Print Official Fee Slip">Print Slip</button>${due?`<button class="action-btn" data-whatsapp="${s.id}">Send WhatsApp</button>`:''}${label==='Paid'?`<button class="action-btn" data-mark-pending="${s.id}">Mark pending</button>`:`<button class="action-btn" data-paid="${s.id}">Mark paid</button>`}</td></tr>`}).join(''):'<tr><td colspan="6" class="empty-row">No fee records found.</td></tr>';
 document.querySelectorAll('#feesTable [data-receipt]').forEach(b=>b.onclick=()=>showReceipt(b.dataset.receipt));
 document.querySelectorAll('[data-whatsapp]').forEach(b=>b.onclick=()=>{const s=students.find(x=>x.id===b.dataset.whatsapp);if(s)whatsappReminder(s);});
 document.querySelectorAll('[data-paid]').forEach(b=>b.onclick=()=>{const s=students.find(x=>x.id===b.dataset.paid);s.feeStatus='Paid';s.paidMonth=monthKey();s.lastPaid=today();s.dueDate=datePlusMonth(today());save();toast('Fee payment recorded.');});
 document.querySelectorAll('[data-mark-pending]').forEach(b=>b.onclick=()=>{const s=students.find(x=>x.id===b.dataset.markPending);s.feeStatus='Pending';save();toast('Fee status updated.');});
 const active=students.filter(isActive);const pending=active.filter(s=>studentFeeLabel(s)!=='Paid').length;const collected=active.filter(s=>s.feeStatus==='Paid'&&s.paidMonth===monthKey()).reduce((a,s)=>a+Number(s.monthlyFee||0),0);
 $('feesTotalCollected').textContent=money(collected);$('feesPendingCount').textContent=pending;
}
function updateStorageInfo(){
 const sStr=localStorage.getItem('shardha_students')||'';
 const hStr=localStorage.getItem('shardha_half_time_visits')||'';
 const cfgStr=localStorage.getItem('shardha_settings')||'';
 const bStr=localStorage.getItem('sharda_booking_requests')||'';
 const totalBytes=(sStr.length+hStr.length+cfgStr.length+bStr.length)*2;
 const kb=(totalBytes/1024).toFixed(1);
 const infoEl=$('storageUsageText');
 if(infoEl) infoEl.textContent=`${kb} KB used in browser LocalStorage`;
}
function renderReports(){
 const active=students.filter(isActive),occupied=active.filter(s=>s.seat).length,pending=active.filter(s=>studentFeeLabel(s)!=='Paid').length;
 $('reportStudents').textContent=students.length;$('reportOccupied').textContent=occupied;$('reportVacant').textContent=CAPACITY-occupied;$('reportPending').textContent=pending;
 const collected=active.filter(s=>s.feeStatus==='Paid'&&s.paidMonth===monthKey()).reduce((a,s)=>a+Number(s.monthlyFee||0),0);
 $('reportSummary').textContent=`There are ${students.length} lifetime students, including ${active.length} active and ${students.length-active.length} completed/left. ${occupied} of 100 seats are occupied and ${CAPACITY-occupied} seats are available. ${pending} students have pending monthly fees. ${money(collected)} has been recorded as collected this month.`;
 updateStorageInfo();
}
function renderAll(){renderDashboard();renderSeatOptions($('studentSeat').value);renderSeats();renderRecords();renderFees();renderReports();renderHalfTime();renderBookingRequests();}
let selectedStudentPhoto = '';
let photoRemoved = false;
function setPhotoPreview(dataUrl=''){
 selectedStudentPhoto=dataUrl;photoRemoved=!dataUrl;const wrap=$('photoPreviewWrap'),preview=$('photoPreview'),upload=$('photoUploadLabel');
 if(dataUrl){preview.src=dataUrl;wrap.hidden=false;upload.classList.add('has-photo');}
 else{preview.removeAttribute('src');wrap.hidden=true;upload.classList.remove('has-photo');}
}
function clearStudentPhoto(){setPhotoPreview('');$('studentPhoto').value='';}
$('studentPhoto').addEventListener('change',()=>{
 const file=$('studentPhoto').files&&$('studentPhoto').files[0];if(!file)return;
 if(!['image/jpeg','image/png','image/webp'].includes(file.type)){toast('Please choose a JPG, PNG or WebP image.');clearStudentPhoto();return;}
 if(file.size>2*1024*1024){toast('Photo must be 2 MB or smaller.');clearStudentPhoto();return;}
 const reader=new FileReader();reader.onload=()=>{const img=new Image();img.onload=()=>{const max=480,scale=Math.min(1,max/Math.max(img.width,img.height));const canvas=document.createElement('canvas');canvas.width=Math.round(img.width*scale);canvas.height=Math.round(img.height*scale);canvas.getContext('2d').drawImage(img,0,0,canvas.width,canvas.height);setPhotoPreview(canvas.toDataURL('image/jpeg',0.78));};img.onerror=()=>{toast('Could not read this image. Please try another photo.');clearStudentPhoto();};img.src=reader.result;};reader.onerror=()=>{toast('Could not load this photo. Please try again.');clearStudentPhoto();};reader.readAsDataURL(file);
});
$('removePhotoBtn').addEventListener('click',clearStudentPhoto);
$('studentForm').addEventListener('submit',e=>{
 e.preventDefault();const id=$('studentId').value,roll=$('studentRoll').value.trim()||nextStudentId();
 if(students.some(s=>s.roll.toLowerCase()===roll.toLowerCase()&&s.id!==id)){toast('This Student ID / Roll No. already exists.');return;}
 const old=students.find(s=>s.id===id),status=$('initialFeeStatus').value;const seat=old&&!isActive(old)?'':$('studentSeat').value;if(seat&&occupiedSeat(seat,id)){toast('This seat is already occupied.');return;}
 const student={id:id||String(Date.now()),libraryId:old?.libraryId||old?.roll||roll,membershipStatus:old?.membershipStatus||'Active',name:$('studentName').value.trim(),phone:$('studentPhone').value.trim(),roll,course:$('studentCourse').value.trim(),joining:$('joiningDate').value,monthlyFee:Number($('monthlyFee').value),seat,feeStatus:old?old.feeStatus:status,dueDate:old?.dueDate||(status==='Paid'?datePlusMonth(today()):today()),paidMonth:old?.paidMonth||(status==='Paid'?monthKey():''),lastPaid:old?.lastPaid||(status==='Paid'?today():''),photo:selectedStudentPhoto||(photoRemoved?'':(old?.photo||''))};
 if(old)students=students.map(s=>s.id===id?student:s);else students.push(student);
 save();$('studentForm').reset();$('studentId').value='';$('studentRoll').value=nextStudentId();$('joiningDate').value=today();syncJoiningDateDisplay();$('studentSubmit').textContent='Save Student';clearStudentPhoto();renderSeatOptions();go('records');toast(old?'Student details updated.':'Student registered successfully.');
});
$('studentCancel').addEventListener('click',()=>{setTimeout(()=>{$('studentId').value='';$('studentSubmit').textContent='Save Student';$('studentRoll').value=nextStudentId();$('joiningDate').value=today();syncJoiningDateDisplay();clearStudentPhoto();renderSeatOptions();},0);});
function editStudent(id){const s=students.find(x=>x.id===id);if(!s)return;go('students');$('studentId').value=s.id;$('studentName').value=s.name;$('studentPhone').value=s.phone;$('studentRoll').value=s.libraryId||s.roll;$('studentCourse').value=s.course;$('joiningDate').value=s.joining;syncJoiningDateDisplay();$('monthlyFee').value=s.monthlyFee;$('initialFeeStatus').value=s.feeStatus;renderSeatOptions(s.seat);$('studentSeat').value=s.seat;setPhotoPreview(s.photo||'');$('studentSubmit').textContent='Update Student';window.scrollTo({top:0,behavior:'smooth'});}

function applySettings(){
 const name=settings.libraryName||'Sharda Library';
 const brandH1=$('brandTitle');if(brandH1)brandH1.innerHTML=escapeHTML(name).replace(/\s+/g,'<br>');
 const topH2=$('topbarTitle');if(topH2)topH2.textContent=name;
 const footName=$('footerLibraryName');if(footName)footName.textContent=name;
 const pubTitle=$('publicHeroTitle');if(pubTitle)pubTitle.textContent=`${name} & Reading Room`;
 const pubUpi=$('publicUpiDisplay');if(pubUpi)pubUpi.textContent=settings.upiId||'teenachoudhary186@ybl';
 if($('settingsLibraryName'))$('settingsLibraryName').value=name;
 if($('settingsUpiId'))$('settingsUpiId').value=settings.upiId||'teenachoudhary186@ybl';

}

let publicSeatFilter = 'all';

function renderPublicDashboard(){
 const active=students.filter(isActive);
 const occupied=active.filter(s=>s.seat).length;
 const available=CAPACITY-occupied;

 if($('publicAvailableSeats'))$('publicAvailableSeats').textContent=available;
 if($('publicOccupiedSeats'))$('publicOccupiedSeats').textContent=occupied;
 if($('publicSeatCounterPill'))$('publicSeatCounterPill').textContent=`${available} / ${CAPACITY} Desks Vacant`;
 if($('filterTabVacant'))$('filterTabVacant').textContent=`🟢 Available (${available})`;
 if($('filterTabOccupied'))$('filterTabOccupied').textContent=`⚪ Reserved (${occupied})`;

 const phone = settings.libraryPhone || '9876543210';
 const libName = settings.libraryName || 'Sharda Library';
 const waBtn=$('publicWhatsAppInquiryBtn');
 if(waBtn){
  const msg=`Hello ${libName}, I want to inquire about reading room admission and seat availability.`;
  waBtn.href=`https://wa.me/91${phone}?text=${encodeURIComponent(msg)}`;
 }
 renderPublicSeats();
}

function renderPublicSeats(){
 const grid=$('publicSeatGrid');
 if(!grid)return;
 const q=($('publicSeatSearch')?.value||'').trim().toLowerCase();
 const cleanQ = q.replace(/\D/g, '');

 const seatsHtml = Array.from({length:CAPACITY},(_,i)=>{
  const seat=String(i+1).padStart(2,'0');
  const isOcc=occupiedSeat(seat);

  if(publicSeatFilter === 'vacant' && isOcc) return '';
  if(publicSeatFilter === 'occupied' && !isOcc) return '';

  if(cleanQ && !seat.includes(cleanQ) && !seat.includes(cleanQ.padStart(2, '0'))) return '';
  else if(q && !cleanQ && !seat.includes(q)) return '';

  return `<button class="seat public-seat ${isOcc?'occupied':'vacant'}" data-public-seat="${seat}">
   ${seat}
   <small>${isOcc?'Reserved':'Available'}</small>
  </button>`;
 }).join('');

 grid.innerHTML = seatsHtml || '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--muted);font-weight:600">No desks match this filter criteria.</div>';

 grid.querySelectorAll('[data-public-seat]').forEach(b=>{
  b.addEventListener('click',()=>showPublicSeat(b.dataset.publicSeat));
 });
}

function showPublicSeat(seat){
 const isOcc=occupiedSeat(seat);
 const modal=$('publicSeatModal');
 const title=$('publicSeatModalTitle');
 const text=$('publicSeatModalText');
 const actions=$('publicSeatModalActions');
 if(!modal)return;

 title.textContent=`Desk ${seat}`;
 actions.innerHTML='';

 const phone = settings.libraryPhone || '9876543210';
 const libName = settings.libraryName || 'Sharda Library';

 if(isOcc){
  text.textContent=`Desk ${seat} is currently reserved by an enrolled member. Please check any of our vacant green desks or contact our reception for upcoming vacancy notifications.`;
  const closeBtn=document.createElement('button');
  closeBtn.className='btn-primary';
  closeBtn.textContent='Close';
  closeBtn.onclick=()=>modal.classList.remove('show');
  actions.append(closeBtn);
 } else {
  text.textContent=`Desk ${seat} is completely available for immediate allotment today! You can lock this desk now by speaking to our front desk or sending a quick booking message on WhatsApp.`;
  const waBtn=document.createElement('a');
  waBtn.className='btn-primary';
  waBtn.textContent='Reserve on WhatsApp 💬';
  waBtn.target='_blank';
  waBtn.rel='noopener';
  const msg=`Hello ${libName}, I would like to reserve Desk ${seat}. Please share the registration procedure.`;
  waBtn.href=`https://wa.me/91${phone}?text=${encodeURIComponent(msg)}`;
  actions.append(waBtn);

  const closeBtn=document.createElement('button');
  closeBtn.className='btn-light';
  closeBtn.textContent='Close';
  closeBtn.onclick=()=>modal.classList.remove('show');
  actions.append(closeBtn);
 }
 modal.classList.add('show');
}

async function photoToDataUrl(photoUrl){
 if(!photoUrl||String(photoUrl).startsWith('data:'))return photoUrl||'';
 if(!/^\/api\/photos\/[a-f0-9]{32}$/.test(String(photoUrl)))throw new Error('A student photo reference is invalid; backup was not exported.');
 const response=await fetch(photoUrl,{credentials:'same-origin'});
 if(!response.ok)throw new Error('A student photo could not be downloaded; backup was not exported.');
 const blob=await response.blob();
 return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result||''));reader.onerror=()=>reject(new Error('Could not read a student photo for backup.'));reader.readAsDataURL(blob);});
}
async function exportBackupJSON(){
 const button=$('backupJsonBtn');if(button){button.disabled=true;button.textContent='Preparing backup…';}
 try{
  const backupStudents=await Promise.all(students.map(async student=>({...student,photo:await photoToDataUrl(student.photo||'')})));
  const backupData={appName:'Sharda Library Management System',version:'3.0.0',exportedAt:new Date().toISOString(),settings,students:backupStudents,halfVisits,bookingRequests,seatHistory};
  const jsonStr=JSON.stringify(backupData,null,2);
  const blob=new Blob([jsonStr],{type:'application/json;charset=utf-8;'});
  const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`sharda-library-backup-${today()}.json`;a.click();URL.revokeObjectURL(a.href);
  toast('Full JSON backup downloaded, including student photos.');
 }catch(error){toast('Backup export failed: '+error.message);}
 finally{if(button){button.disabled=false;button.textContent='⤓ Backup JSON';}}
}

function restoreBackupJSON(file){
 if(!file)return;
 const reader=new FileReader();
 reader.onload=async e=>{
  try{
   const data=JSON.parse(e.target.result);
   if(!data||(!Array.isArray(data.students)&&!Array.isArray(data.halfVisits))){toast('Invalid backup file. Please select a valid Sharda Library JSON backup.');return;}
   const restoredStudents=Array.isArray(data.students)?data.students:students;
   const restoredVisits=Array.isArray(data.halfVisits)?data.halfVisits:halfVisits;
   const restoredBookings=Array.isArray(data.bookingRequests)?data.bookingRequests:bookingRequests;
   const restoredHistory=Array.isArray(data.seatHistory)?data.seatHistory:seatHistory;
   const restoredSettings=data.settings&&typeof data.settings==='object'?Object.assign({},defaultSettings,data.settings):settings;
   if(!confirm(`Restore backup from ${data.exportedAt?new Date(data.exportedAt).toLocaleDateString():'file'}?\n\nThis will restore ${restoredStudents.length} students and ${restoredVisits.length} visits.\nCurrent server records will be replaced. A safety backup will be created first.`))return;
   await apiRequest('/api/backups',{method:'POST',body:'{}'});
   const saved=await apiRequest('/api/data',{method:'PUT',body:JSON.stringify({settings:restoredSettings,students:restoredStudents,halfVisits:restoredVisits,bookingRequests:restoredBookings,seatHistory:restoredHistory,expectedUpdatedAt:serverDataVersion})});
   serverDataVersion=saved.updatedAt||serverDataVersion;
   students=saved.students||restoredStudents;halfVisits=restoredVisits;bookingRequests=restoredBookings;seatHistory=restoredHistory;settings=restoredSettings;
   // Store the compact server photo URLs in LocalStorage, not large base64 images.
   try{localStorage.setItem('shardha_students',JSON.stringify(students));localStorage.setItem('shardha_half_time_visits',JSON.stringify(halfVisits));localStorage.setItem('sharda_booking_requests',JSON.stringify(bookingRequests));localStorage.setItem('sharda_seat_history',JSON.stringify(seatHistory));localStorage.setItem('shardha_settings',JSON.stringify(settings));}catch{}
   renderAll();applySettings();toast(`Restored ${students.length} students and ${halfVisits.length} half-time visits.`);
  }catch(err){toast('Backup restore failed: '+(err.message||'Please check the file and try again.'));}
 };
 reader.onerror=()=>toast('Error reading backup file.');
 reader.readAsText(file);
}

$('recordSearch').addEventListener('input',renderRecords);$('recordTypeFilter').addEventListener('change',renderRecords);$('feeSearch').addEventListener('input',renderFees);$('seatSearch').addEventListener('input',renderSeats);
$('exportBtn').addEventListener('click',()=>{const rows=[['Name','Library Student ID','Mobile','Course','Joining Date','Seat','Membership Status','Monthly Fee','Fee Status','Due Date'],...students.map(s=>[s.name,s.libraryId||s.roll,s.phone,s.course,s.joining,isActive(s)?s.seat:'',isActive(s)?'Active':'Completed / Left',s.monthlyFee,s.feeStatus,s.dueDate])];const csv=rows.map(r=>r.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\n');const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='sharda-library-report.csv';a.click();URL.revokeObjectURL(a.href);});
$('backupJsonBtn')?.addEventListener('click',exportBackupJSON);
$('restoreJsonBtn')?.addEventListener('click',()=>$('restoreFileInput')?.click());
$('restoreFileInput')?.addEventListener('change',e=>{const file=e.target.files&&e.target.files[0];if(file){restoreBackupJSON(file);e.target.value='';}});
$('settingsForm')?.addEventListener('submit',e=>{
 e.preventDefault();
 settings.libraryName=$('settingsLibraryName').value.trim()||'Sharda Library';
 settings.upiId=$('settingsUpiId').value.trim()||'teenachoudhary186@ybl';
 safeSetItem('shardha_settings',JSON.stringify(settings));
 applySettings();
 toast('Library settings saved successfully.');
});

$('adminLoginForm')?.addEventListener('submit', async e=>{
 e.preventDefault();
 const user=$('loginUsername').value.trim();
 const pass=$('loginPassword').value;
 const alertEl=$('loginErrorAlert');
 const submit=e.submitter || $('adminLoginForm').querySelector('[type=submit]');
 if(submit){submit.disabled=true;submit.textContent='Signing in…';}
 try {
  await apiRequest('/api/auth/login',{method:'POST',body:JSON.stringify({adminId:user,password:pass})});
  if(alertEl)alertEl.hidden=true;
  setAdminLoggedIn(true); $('loginPassword').value='';
  try { await loadServerDataOrMigrate(); }
  catch(syncError) { toast('Signed in, but server data could not load: '+syncError.message); }
  toast('Welcome to Admin Workspace!'); go('dashboard');
 } catch(error) {
  if(alertEl){alertEl.hidden=false;alertEl.textContent=error.message;}
  toast('Authentication failed.');
 } finally {if(submit){submit.disabled=false;submit.textContent='Sign In to Admin Workspace';}}
});

async function handleLogout(){
 if(!confirm('Are you sure you want to log out of the Admin Workspace?')) return;
 try { await apiRequest('/api/auth/logout',{method:'POST',body:'{}'}); } catch(error) { toast(error.message); }
 setAdminLoggedIn(false); toast('Logged out of Admin Portal.'); go('public');
}
$('sidebarLogoutBtn')?.addEventListener('click',handleLogout);
$('topbarLogoutBtn')?.addEventListener('click',handleLogout);

const FORGOT_STEPS = ['forgotSendOtpForm','forgotVerifyOtpForm','forgotResetForm'];
function showOnly(activeId,ids){ids.forEach(id=>{const form=$(id);if(form)form.hidden=id!==activeId;});}
let passwordResetToken = '';
function resetForgotFlow(message=''){passwordResetToken='';FORGOT_STEPS.forEach(id=>$(id)?.reset());showOnly('forgotSendOtpForm',FORGOT_STEPS);$('forgotPasswordMessage').textContent=message;}
let otpChannel='email';
function applyOtpChannel(){const sms=otpChannel==='sms',input=$('forgotMobile');if(!input)return;$('forgotContactLabel').textContent=sms?'Registered Admin Mobile':'Registered Admin Email';input.type=sms?'tel':'email';input.maxLength=sms?10:254;input.placeholder=sms?'10-digit registered mobile':'Registered admin email';input.setAttribute('inputmode',sms?'numeric':'email');$('forgotChangeNumberBtn').textContent=sms?'Change number':'Change email';const send=$('changeSendOtpBtn');if(send)send.textContent=sms?'Send OTP to Registered Mobile':'Send OTP to Registered Email';}
async function loadOtpChannel(){try{const health=await apiRequest('/api/health');if(health&&health.otpChannel)otpChannel=health.otpChannel;}catch{}applyOtpChannel();}
loadOtpChannel();
const otpWhere=()=>otpChannel==='sms'?'registered mobile':'registered email';
$('showForgotPasswordBtn')?.addEventListener('click',()=>{const panel=$('forgotPasswordPanel');panel.hidden=!panel.hidden;if(!panel.hidden){resetForgotFlow();$('forgotMobile').focus();}});
async function forgotSendOtp(){const msg=$('forgotPasswordMessage');msg.textContent='Sending OTP…';try{await apiRequest('/api/auth/forgot-password/send-otp',{method:'POST',body:JSON.stringify({contact:$('forgotMobile').value.trim()})});showOnly('forgotVerifyOtpForm',FORGOT_STEPS);$('forgotOtp').value='';$('forgotOtp').focus();msg.textContent=`OTP sent to the ${otpWhere()}. It expires in 5 minutes.${otpChannel==='email'?' Check the spam folder if you do not see it.':''}`;}catch(error){msg.textContent=error.message;}}
$('forgotSendOtpForm')?.addEventListener('submit',e=>{e.preventDefault();forgotSendOtp();});
$('forgotResendBtn')?.addEventListener('click',async()=>{const msg=$('forgotPasswordMessage');msg.textContent='Resending OTP…';try{await apiRequest('/api/auth/forgot-password/resend-otp',{method:'POST',body:JSON.stringify({contact:$('forgotMobile').value.trim()})});msg.textContent=otpChannel==='sms'?'The same OTP has been resent. Use it before its original expiry.':'A new OTP has been emailed. Use the latest one; older codes no longer work.';}catch(error){msg.textContent=error.message;}});
$('forgotChangeNumberBtn')?.addEventListener('click',()=>{showOnly('forgotSendOtpForm',FORGOT_STEPS);$('forgotPasswordMessage').textContent='';$('forgotMobile').focus();});
$('forgotVerifyOtpForm')?.addEventListener('submit',async e=>{e.preventDefault();const msg=$('forgotPasswordMessage');msg.textContent='Verifying OTP…';try{const result=await apiRequest('/api/auth/forgot-password/verify-otp',{method:'POST',body:JSON.stringify({contact:$('forgotMobile').value.trim(),otp:$('forgotOtp').value.trim()})});passwordResetToken=result.resetToken;showOnly('forgotResetForm',FORGOT_STEPS);$('forgotNewPassword').focus();msg.textContent='OTP verified. Set your new password.';}catch(error){msg.textContent=error.message;}});
$('forgotResetForm')?.addEventListener('submit',async e=>{e.preventDefault();const first=$('forgotNewPassword').value,second=$('forgotConfirmPassword').value,msg=$('forgotPasswordMessage');if(first!==second){msg.textContent='New password and confirmation do not match.';return;}try{await apiRequest('/api/auth/forgot-password/reset',{method:'POST',body:JSON.stringify({resetToken:passwordResetToken,newPassword:first})});resetForgotFlow('Password updated successfully. You can now sign in.');}catch(error){msg.textContent=error.message;}});
let passwordChangeToken = '';
const CHANGE_PASSWORD_STEPS = ['changePasswordSendOtpForm','changePasswordVerifyOtpForm','changePasswordUpdateForm'];
function showChangePasswordStep(activeId){CHANGE_PASSWORD_STEPS.forEach(id=>{const form=$(id);if(form)form.hidden=id!==activeId;});}
function resetChangePasswordFlow(message=''){passwordChangeToken='';CHANGE_PASSWORD_STEPS.forEach(id=>$(id)?.reset());showChangePasswordStep('changePasswordSendOtpForm');$('changePasswordMessage').textContent=message;}
$('changePasswordSendOtpForm')?.addEventListener('submit',async e=>{e.preventDefault();const msg=$('changePasswordMessage');msg.textContent='Sending OTP…';try{const result=await apiRequest('/api/auth/change-password/send-otp',{method:'POST',body:'{}'});showChangePasswordStep('changePasswordVerifyOtpForm');$('changePasswordOtp').value='';$('changePasswordOtp').focus();msg.textContent=`OTP sent to ${result.maskedTarget||result.maskedMobile}. It expires in 5 minutes.`;}catch(error){msg.textContent=error.message;}});
$('changeResendBtn')?.addEventListener('click',async()=>{const msg=$('changePasswordMessage');msg.textContent='Resending OTP…';try{const result=await apiRequest('/api/auth/change-password/resend-otp',{method:'POST',body:'{}'});msg.textContent=result.channel==='sms'?`The same OTP was resent to ${result.maskedMobile}. Use it before its original expiry.`:`A new OTP was emailed to ${result.maskedTarget}. Older codes no longer work.`;}catch(error){msg.textContent=error.message;}});
$('changeCancelBtn')?.addEventListener('click',()=>resetChangePasswordFlow());
$('changePasswordVerifyOtpForm')?.addEventListener('submit',async e=>{e.preventDefault();const msg=$('changePasswordMessage');msg.textContent='Verifying OTP…';try{const result=await apiRequest('/api/auth/change-password/verify-otp',{method:'POST',body:JSON.stringify({otp:$('changePasswordOtp').value.trim()})});passwordChangeToken=result.changeToken;showChangePasswordStep('changePasswordUpdateForm');$('changeNewPassword').focus();msg.textContent='OTP verified. Enter your new password.';}catch(error){msg.textContent=error.message;}});
$('changePasswordUpdateForm')?.addEventListener('submit',async e=>{e.preventDefault();const first=$('changeNewPassword').value,second=$('changeConfirmPassword').value,msg=$('changePasswordMessage');if(first!==second){msg.textContent='New password and confirmation do not match.';return;}try{await apiRequest('/api/auth/change-password',{method:'POST',body:JSON.stringify({changeToken:passwordChangeToken,newPassword:first})});resetChangePasswordFlow();setAdminLoggedIn(false);dataSyncReady=false;go('login');$('changePasswordMessage').textContent='Password updated. Please sign in again.';toast('Password updated successfully.');}catch(error){msg.textContent=error.message;}});

$('togglePasswordBtn')?.addEventListener('click',()=>{
 const input=$('loginPassword');
 if(!input)return;
 const isPass=input.type==='password';
 input.type=isPass?'text':'password';
 $('togglePasswordBtn').textContent=isPass?'🙈':'👁️';
});

$('closePublicSeatModal')?.addEventListener('click',()=>$('publicSeatModal')?.classList.remove('show'));
$('publicSeatModal')?.addEventListener('click',e=>{if(e.target===$('publicSeatModal'))$('publicSeatModal').classList.remove('show');});
$('closeReceiptModal')?.addEventListener('click',()=>$('receiptModal')?.classList.remove('show'));
$('dismissReceiptBtn')?.addEventListener('click',()=>$('receiptModal')?.classList.remove('show'));
$('receiptModal')?.addEventListener('click',e=>{if(e.target===$('receiptModal'))$('receiptModal').classList.remove('show');});
$('printReceiptBtn')?.addEventListener('click',()=>window.print());
$('publicSeatSearch')?.addEventListener('input',renderPublicSeats);
$('publicBookSeatBtn')?.addEventListener('click',e=>{e.preventDefault();$('bookingSection')?.scrollIntoView({behavior:'smooth'});});
document.querySelectorAll('[data-booking-link]').forEach(link=>link.addEventListener('click',e=>{e.preventDefault();$('bookingSection')?.scrollIntoView({behavior:'smooth'});}));

document.querySelectorAll('.filter-tab').forEach(b=>{
 b.addEventListener('click',()=>{
  document.querySelectorAll('.filter-tab').forEach(t=>t.classList.remove('active'));
  b.classList.add('active');
  publicSeatFilter=b.dataset.filter||'all';
  renderPublicSeats();
 });
});

$('copyUpiBtn')?.addEventListener('click',()=>{
 const upi=settings.upiId||'teenachoudhary186@ybl';
 if(navigator.clipboard&&navigator.clipboard.writeText){
  navigator.clipboard.writeText(upi).then(()=>toast(`UPI ID copied: ${upi}`)).catch(()=>toast(`UPI ID: ${upi}`));
 }else{
  toast(`UPI ID: ${upi}`);
 }
});

document.querySelectorAll('.faq-question').forEach(btn=>{
 btn.addEventListener('click',()=>{
  const item=btn.closest('.faq-item');
  if(!item)return;
  const isOpen=item.classList.contains('active');
  document.querySelectorAll('.faq-item').forEach(i=>i.classList.remove('active'));
  if(!isOpen)item.classList.add('active');
 });
});

$('exportHalfBtn')?.addEventListener('click',()=>{
 const rows=[
  ['Student Name','Mobile','Visit Date','Temporary Seat','Entry Time','Exit Time','Duration','Fee Amount (₹)','Payment Status'],
  ...halfVisits.map(v=>[v.name,v.phone,v.date,v.seat,v.entry,v.exit||'Active',durationText(v.entry,v.exit),v.fee,v.payment])
 ];
 const csv=rows.map(r=>r.map(v=>'"'+String(v??'').replace(/"/g,'""')+'"').join(',')).join('\n');
 const blob=new Blob([csv],{type:'text/csv;charset=utf-8;'});
 const a=document.createElement('a');
 a.href=URL.createObjectURL(blob);
 a.download=`sharda-library-half-time-visits-${today()}.csv`;
 a.click();
 URL.revokeObjectURL(a.href);
 toast('Half-time visits CSV exported.');
});


// Online booking requests: stored in this browser's LocalStorage, consistent with the current app data model.
function saveBookingRequests(){safeSetItem('sharda_booking_requests',JSON.stringify(bookingRequests));renderBookingRequests();}
function nextBookingId(){const year=new Date().getFullYear();const prefix=`SHL-REQ-${year}-`;const max=bookingRequests.reduce((n,r)=>{const m=String(r.bookingId||'').match(new RegExp('^SHL-REQ-'+year+'-(\\d+)$'));return m?Math.max(n,Number(m[1])):n;},0);return prefix+String(max+1).padStart(4,'0');}
function statusClass(status){return status==='Approved'?'paid':'pending';}
function renderBookingRequests(){
 const pending=bookingRequests.filter(r=>r.status==='Pending').length;
 const approved=bookingRequests.filter(r=>r.status==='Approved').length;
 const rejected=bookingRequests.filter(r=>r.status==='Rejected').length;
 if($('bookingPendingNavCount')){$('bookingPendingNavCount').textContent=pending;$('bookingPendingNavCount').hidden=!pending;}
 if($('bookingPendingCount'))$('bookingPendingCount').textContent=pending;
 if($('bookingApprovedCount'))$('bookingApprovedCount').textContent=approved;
 if($('bookingRejectedCount'))$('bookingRejectedCount').textContent=rejected;
 const table=$('bookingRequestsTable');if(!table)return;
 const q=($('bookingSearch')?.value||'').trim().toLowerCase();const filter=$('bookingFilter')?.value||'all';
 const rows=bookingRequests.filter(r=>(filter==='all'||r.status===filter)&&(r.name+' '+r.phone+' '+r.bookingId).toLowerCase().includes(q)).slice().reverse();
 table.innerHTML=rows.length?rows.map(r=>`<tr><td><b>${escapeHTML(r.bookingId)}</b><br><small>${escapeHTML(r.createdAt||'')}</small></td><td><b>${escapeHTML(r.name)}</b><br><small>${escapeHTML(r.course||'—')}</small></td><td>${escapeHTML(r.phone)}<br><small>${escapeHTML(r.email||'')}</small></td><td>${escapeHTML(r.plan)}<br><small>${escapeHTML(r.shift)}</small></td><td>${escapeHTML(r.joining||'—')}</td><td><span class="status ${statusClass(r.status)}">${escapeHTML(r.status)}</span>${r.reason?`<br><small>${escapeHTML(r.reason)}</small>`:''}</td><td>${r.seat?`Seat ${escapeHTML(r.seat)}`:'—'}</td><td>${r.status==='Pending'?`<button class="action-btn" data-booking-approve="${escapeHTML(r.bookingId)}">Approve &amp; Allocate</button><button class="action-btn danger" data-booking-reject="${escapeHTML(r.bookingId)}">Reject</button>`:`<button class="action-btn" data-booking-message="${escapeHTML(r.bookingId)}">WhatsApp</button>`}</td></tr>`).join(''):'<tr><td colspan="8" class="empty-row">No booking requests found.</td></tr>';
 table.querySelectorAll('[data-booking-approve]').forEach(b=>b.onclick=()=>approveBooking(b.dataset.bookingApprove));
 table.querySelectorAll('[data-booking-reject]').forEach(b=>b.onclick=()=>rejectBooking(b.dataset.bookingReject));
 table.querySelectorAll('[data-booking-message]').forEach(b=>b.onclick=()=>sendBookingWhatsApp(b.dataset.bookingMessage));
}
async function approveBooking(bookingId){
 const request=bookingRequests.find(r=>r.bookingId===bookingId);if(!request||request.status!=='Pending')return;
 const free=freeSeats();if(!free.length){toast('No seats are currently available to allocate.');return;}
 const suggested=free[0];const seatInput=prompt(`Available seats: ${free.join(', ')}\nEnter the seat number to allocate:`,suggested);if(seatInput===null)return;
 const seat=String(seatInput).trim().padStart(2,'0');if(!free.includes(seat)){toast('Please enter a valid currently available seat number.');return;}
 const suggestedFee=request.plan==='Full-Day'?800:500;const feeInput=prompt('Enter monthly fee (₹) for this student:',String(suggestedFee));if(feeInput===null)return;const fee=Number(feeInput);if(!Number.isFinite(fee)||fee<0){toast('Please enter a valid monthly fee.');return;}
 try {
  const result=await apiRequest('/api/booking-requests/approve',{method:'POST',body:JSON.stringify({bookingId,seat,monthlyFee:fee})});
  students.push(result.student);request.status='Approved';request.seat=seat;request.studentId=result.student.id;request.reviewedAt=result.bookingRequest.reviewedAt;
  serverDataVersion=result.updatedAt;safeSetItem('shardha_students',JSON.stringify(students));safeSetItem('sharda_booking_requests',JSON.stringify(bookingRequests));renderAll();toast(`${request.name} approved. Seat ${seat} allocated and student record created.`);
 } catch(error) { toast(error.message||'Could not approve booking.'); }
}
async function rejectBooking(bookingId){const request=bookingRequests.find(r=>r.bookingId===bookingId);if(!request||request.status!=='Pending')return;const reason=prompt('Optional rejection reason:','');if(reason===null)return;try{const result=await apiRequest('/api/booking-requests/reject',{method:'POST',body:JSON.stringify({bookingId,reason:reason.trim()})});request.status='Rejected';request.reason=reason.trim();request.reviewedAt=result.bookingRequest.reviewedAt;serverDataVersion=result.updatedAt;safeSetItem('sharda_booking_requests',JSON.stringify(bookingRequests));renderBookingRequests();toast('Booking request rejected.');}catch(error){toast(error.message||'Could not reject booking.');}}
function sendBookingWhatsApp(bookingId){const r=bookingRequests.find(x=>x.bookingId===bookingId);if(!r)return;const phone=String(r.phone||'').replace(/\D/g,'');if(phone.length!==10){toast('Invalid mobile number on this request.');return;}const lib=settings.libraryName||'Sharda Library';const message=r.status==='Approved'?`Hello ${r.name}, your booking request ${r.bookingId} has been approved. Seat ${r.seat} has been allocated at ${lib}. Please contact the library for joining formalities.`:`Hello ${r.name}, your booking request ${r.bookingId} status is ${r.status}. Please contact ${lib} for details.`;window.open(`https://wa.me/91${phone}?text=${encodeURIComponent(message)}`,'_blank','noopener');}
$('publicBookingForm')?.addEventListener('submit',async e=>{
 e.preventDefault();
 const phone=$('bookingPhone').value.trim();
 if(!/^[0-9]{10}$/.test(phone)){toast('Please enter a valid 10-digit mobile number.');return;}
 const submit=$('publicBookingForm').querySelector('[type=submit]'); if(submit){submit.disabled=true;submit.textContent='Submitting…';}
 try {
  const payload={name:$('bookingName').value.trim(),phone,email:$('bookingEmail').value.trim(),course:$('bookingCourse').value.trim(),plan:$('bookingPlan').value,shift:$('bookingShift').value,joining:$('bookingJoining').value,message:$('bookingMessage').value.trim()};
  const saved=await apiRequest('/api/booking-requests',{method:'POST',body:JSON.stringify(payload)});
  const request={...payload,bookingId:saved.bookingId,status:'Pending',seat:'',reason:'',createdAt:new Date().toLocaleString('en-IN')};
  $('publicBookingForm').reset(); const success=$('bookingSuccess'); success.hidden=false;
  success.innerHTML=`<strong>Request submitted successfully!</strong><span>Your Booking ID is</span><b>${escapeHTML(request.bookingId)}</b><span>Save this ID. You can track your request using this ID and your mobile number below.</span><button type="button" class="action-btn" id="copyBookingIdBtn">Copy Booking ID</button>`;
  $('copyBookingIdBtn').onclick=()=>{if(navigator.clipboard?.writeText)navigator.clipboard.writeText(request.bookingId).then(()=>toast('Booking ID copied.')).catch(()=>toast('Booking ID: '+request.bookingId));else toast('Booking ID: '+request.bookingId);};
  $('statusBookingId').value=request.bookingId; $('statusBookingPhone').value=phone; $('bookingStatusSection').scrollIntoView({behavior:'smooth',block:'center'}); toast('Booking request submitted.');
 } catch(error) { toast(error.message || 'Could not submit booking request.'); }
 finally { if(submit){submit.disabled=false;submit.innerHTML='Submit Booking Request <span>→</span>';} }
});
$('bookingStatusForm')?.addEventListener('submit',async e=>{
 e.preventDefault(); const id=$('statusBookingId').value.trim().toUpperCase(); const phone=$('statusBookingPhone').value.trim(); const result=$('bookingStatusResult');
 try { const r=await apiRequest(`/api/booking-status?id=${encodeURIComponent(id)}&mobile=${encodeURIComponent(phone)}`,{method:'GET',headers:{}}); result.hidden=false;
  const extra=r.status==='Approved'?`<span>Allocated seat: <b>Seat ${escapeHTML(r.seat||'')}</b></span>`:r.status==='Rejected'?`<span>Reason: ${escapeHTML(r.reason||'Please contact the library for details.')}</span>`:'<span>Your request is awaiting admin review. No seat has been reserved yet.</span>';
  result.className='booking-status-result'; result.innerHTML=`<strong>${escapeHTML(r.bookingId)}</strong><span>Status: <b class="status ${statusClass(r.status)}">${escapeHTML(r.status)}</b></span>${extra}`;
 } catch(error) { result.hidden=false; result.innerHTML=`<strong>Request not found</strong><span>${escapeHTML(error.message||'Please check your Booking ID and registered mobile number.')}</span>`; result.className='booking-status-result is-error'; }
});
$('bookingSearch')?.addEventListener('input',renderBookingRequests);$('bookingFilter')?.addEventListener('change',renderBookingRequests);
$('bookingJoining')?.setAttribute('min',today());if($('bookingJoining'))$('bookingJoining').value=today();

students.forEach(s=>{if(!s.libraryId)s.libraryId=s.roll;if(!s.membershipStatus)s.membershipStatus='Active';});
safeSetItem('shardha_students',JSON.stringify(students));
applySettings();
prepareNewStudentId();
updateAuthUI();
refreshAdminSession();


// Half-time visits are stored independently; they never modify regular seat ownership.
function currentTime(){const d=new Date();return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;}
function durationText(entry, exit){if(!exit)return 'Active';const [eh,em]=entry.split(':').map(Number),[xh,xm]=exit.split(':').map(Number);let mins=xh*60+xm-(eh*60+em);if(mins<0)mins+=1440;return `${Math.floor(mins/60)}h ${mins%60}m`;}
function renderHalfSeatOptions(){const sel=$('halfSeat');if(!sel)return;const previous=sel.value;const options=Array.from({length:CAPACITY},(_,i)=>String(i+1).padStart(2,'0')).filter(seat=>!halfVisits.some(v=>v.seat===seat&&!v.exit));sel.innerHTML='<option value="">Choose a seat</option>'+options.map(seat=>`<option value="${seat}">Seat ${seat}${occupiedSeat(seat)?' (regular student assigned)':''}</option>`).join('');if(options.includes(previous))sel.value=previous;}
function renderHalfTime(){if(!$('halfTable'))return;renderHalfSeatOptions();const q=($('halfSearch').value||'').toLowerCase();const rows=halfVisits.filter(v=>(v.name+' '+v.phone+' '+v.seat+' '+v.date).toLowerCase().includes(q));$('halfTable').innerHTML=rows.length?rows.slice().reverse().map(v=>`<tr><td><b>${escapeHTML(v.name)}</b></td><td>${escapeHTML(v.phone)}</td><td>${escapeHTML(v.date)}</td><td>${escapeHTML(v.seat)}</td><td>${escapeHTML(v.entry)}</td><td>${v.exit||'—'}</td><td>${durationText(v.entry,v.exit)}</td><td>${money(v.fee)}</td><td><span class="status ${v.payment.toLowerCase()}">${v.payment}</span></td><td>${!v.exit?`<button class="action-btn" data-half-exit="${v.id}">Mark Exit</button>`:''}${v.payment==='Pending'?`<button class="action-btn" data-half-paid="${v.id}">Mark Paid</button>`:''}<button class="action-btn danger" data-half-delete="${v.id}">Delete</button></td></tr>`).join(''):'<tr><td colspan="10" class="empty-row">No half-time visits found.</td></tr>';
 document.querySelectorAll('[data-half-exit]').forEach(b=>b.onclick=()=>{const v=halfVisits.find(x=>x.id===b.dataset.halfExit);if(v&&!v.exit){v.exit=currentTime();saveHalf();toast('Exit recorded. Temporary desk released.');}});
 document.querySelectorAll('[data-half-paid]').forEach(b=>b.onclick=()=>{const v=halfVisits.find(x=>x.id===b.dataset.halfPaid);if(v){v.payment='Paid';saveHalf();toast('Half-time fee marked as paid.');}});
 document.querySelectorAll('[data-half-delete]').forEach(b=>b.onclick=()=>{if(confirm('Delete this half-time visit record?')){halfVisits=halfVisits.filter(x=>x.id!==b.dataset.halfDelete);saveHalf();toast('Visit record deleted.');}});
}
$('halfDate').value=today();$('halfEntry').value=currentTime();
$('halfTimeForm').addEventListener('submit',e=>{e.preventDefault();const seat=$('halfSeat').value;const regular=students.find(s=>s.seat===seat);if(halfVisits.some(v=>v.seat===seat&&!v.exit)){toast('This desk already has an active half-time student.');return;}if(regular&&!confirm(`Seat ${seat} is permanently assigned to ${regular.name}. Confirm that the student is temporarily away and this desk is actually vacant? Their permanent seat will not be changed.`))return;const visit={id:String(Date.now()),name:$('halfName').value.trim(),phone:$('halfPhone').value.trim(),date:$('halfDate').value,seat,entry:$('halfEntry').value,exit:'',fee:Number($('halfFee').value),payment:$('halfPayment').value};halfVisits.push(visit);saveHalf();$('halfTimeForm').reset();$('halfDate').value=today();$('halfEntry').value=currentTime();toast('Half-time visit saved.');});
$('halfSearch').addEventListener('input',renderHalfTime);


// ---------- Server-side backups, activity log and live statistics ----------
const SERVER_EVENT_LABELS = {
  'login.success':'Admin logged in','login.failed':'Failed login attempt','login.locked':'Login blocked',
  'logout':'Admin logged out','password.changed':'Password changed','password.otp.sent':'Password OTP sent',
  'password.otp.verified':'Password OTP verified','password.otp.failed':'Wrong password OTP',
  'password.reset':'Password reset','password.reset.otp.sent':'Password reset OTP sent',
  'password.reset.otp.verified':'Password reset OTP verified','data.saved':'Data saved',
  'photo.uploaded':'Student photo uploaded','booking.created':'New booking request',
  'booking.approved':'Booking approved','booking.rejected':'Booking rejected',
  'backup.auto':'Automatic backup','backup.manual':'Manual backup','backup.restored':'Backup restored',
  'backup.downloaded':'Backup downloaded'
};
function serverDateTime(iso){const date=new Date(iso);return Number.isNaN(date.getTime())?'—':date.toLocaleString('en-IN',{day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});}
function serverBackupLabel(name){const match=String(name).match(/-(auto|manual|pre-save|pre-restore)\.json$/);return ({auto:'Daily (automatic)',manual:'Manual','pre-save':'Before save','pre-restore':'Before restore'})[match&&match[1]]||'Backup';}
async function loadServerTools(){
  if(!adminAuthenticated)return;
  try{
    const [backups,audit,stats]=await Promise.all([
      apiRequest('/api/backups',{method:'GET',headers:{}}),
      apiRequest('/api/audit?limit=30',{method:'GET',headers:{}}),
      apiRequest('/api/stats',{method:'GET',headers:{}})
    ]);
    $('serverBackupsTable').innerHTML=backups.backups.length?backups.backups.slice(0,15).map(item=>`<tr><td><b>${escapeHTML(serverBackupLabel(item.name))}</b><br><small>${Math.max(1,Math.round(item.size/1024))} KB</small></td><td>${escapeHTML(serverDateTime(item.createdAt))}</td><td><a class="action-btn" href="/api/backups/${encodeURIComponent(item.name)}" download>Download</a><button class="action-btn danger" data-restore-server-backup="${escapeHTML(item.name)}" type="button">Restore</button></td></tr>`).join(''):'<tr><td colspan="3" class="empty-row">No backups yet.</td></tr>';
    $('auditTable').innerHTML=audit.entries.length?audit.entries.map(item=>`<tr><td>${escapeHTML(serverDateTime(item.at))}</td><td>${escapeHTML(SERVER_EVENT_LABELS[item.event]||item.event)}</td><td><small>${escapeHTML(item.ip||'')}</small></td></tr>`).join(''):'<tr><td colspan="3" class="empty-row">No activity yet.</td></tr>';
    $('serverStatsLine').textContent=`This month collected: ${money(stats.fees.collectedThisMonth)} · Pending fees: ${money(stats.fees.pendingAmount)} (${stats.fees.pendingCount}) · Renewals due: ${stats.fees.renewalDue} · Pending booking requests: ${stats.bookings.pending}`;
  }catch(error){toast('Could not load server tools: '+error.message);}
}
$('createServerBackupBtn')?.addEventListener('click',async()=>{try{await apiRequest('/api/backups',{method:'POST',body:'{}'});toast('Server backup created.');await loadServerTools();}catch(error){toast(error.message);}});
$('refreshAuditBtn')?.addEventListener('click',loadServerTools);
$('serverBackupsTable')?.addEventListener('click',async event=>{
  const button=event.target.closest('[data-restore-server-backup]');if(!button)return;
  const name=button.dataset.restoreServerBackup;
  if(!confirm('Restore this server backup? Current data will be replaced. A safety backup is created first.'))return;
  try{
    await apiRequest('/api/backups/'+encodeURIComponent(name)+'/restore',{method:'POST',body:'{}'});
    await loadServerDataOrMigrate();toast('Backup restored successfully.');await loadServerTools();
  }catch(error){toast('Restore failed: '+error.message);}
});
