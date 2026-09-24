// ============================================================
// Ma'hdu Rahmat — Supabase initialization + Firestore-compatible
// data adapter for the current portal UI.
//
// The adapter deliberately keeps the existing portal.js helper surface
// stable while we migrate the application module-by-module to Postgres.
// No Firebase SDK is loaded here.
// ============================================================

const createClient = window.supabase && window.supabase.createClient;
const cfg = window.MAHDU_SUPABASE_CONFIG || {};
if (!createClient) {
  throw new Error('Ma’hdu Rahmat: Supabase JavaScript library did not load.');
}

if (!cfg.url || cfg.url.indexOf('PASTE_') === 0 || !cfg.publishableKey || cfg.publishableKey.indexOf('PASTE_') === 0) {
  console.error('Ma’hdu Rahmat: Supabase is not configured. Update supabase-config.js with your project URL and publishable key.');
}

const supabase = createClient(cfg.url, cfg.publishableKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true
  }
});

const TABLE_MAP = {
  users: 'users',
  applicants: 'applicants',
  students: 'students',
  staffRequests: 'staff_requests',
  staffAccounts: 'staff_accounts',
  academicSessions: 'academic_sessions',
  matricSequences: 'matric_sequences',
  payments: 'payments',
  announcements: 'announcements',
  announcementReads: 'announcement_reads',
  config: 'config',
  auditLogs: 'audit_logs'
};

function tableName(name) {
  return TABLE_MAP[name] || name;
}

// The existing portal uses camelCase field names, while the PostgreSQL
// schema uses snake_case. Keep that UI contract stable at the adapter edge.
function camelToSnake(value) {
  return value.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase());
}

function snakeToCamel(value) {
  return value.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
}

function toDbKey(key) {
  return key.includes('_') ? key : camelToSnake(key);
}

function fromDbRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [snakeToCamel(key), value]));
}

function toDbObject(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).map(([key, value]) => [toDbKey(key), value]));
}

function collection(db, name) {
  return { __kind: 'collection', table: tableName(name) };
}

function doc(db, collectionName, id) {
  return { __kind: 'doc', table: tableName(collectionName), id: id };
}

function where(field, operator, value) {
  return { field: field, operator: operator, value: value };
}

function query(collectionRef, ...constraints) {
  return { __kind: 'query', table: collectionRef.table, constraints: constraints };
}

function snapshotFromRows(rows) {
  const safeRows = rows || [];
  return {
    empty: safeRows.length === 0,
    size: safeRows.length,
    forEach(callback) {
      safeRows.forEach((row) => callback({
        id: row.id,
        data() { return fromDbRow(row); }
      }));
    }
  };
}

async function getDocs(ref) {
  let builder = supabase.from(ref.table).select('*');
  const constraints = ref.constraints || [];
  for (const c of constraints) {
    if (c.operator === '==') builder = builder.eq(toDbKey(c.field), c.value);
    else if (c.operator === '!=') builder = builder.neq(toDbKey(c.field), c.value);
    else if (c.operator === '>') builder = builder.gt(toDbKey(c.field), c.value);
    else if (c.operator === '>=') builder = builder.gte(toDbKey(c.field), c.value);
    else if (c.operator === '<') builder = builder.lt(toDbKey(c.field), c.value);
    else if (c.operator === '<=') builder = builder.lte(toDbKey(c.field), c.value);
    else throw new Error('Unsupported query operator: ' + c.operator);
  }
  const { data, error } = await builder;
  if (error) throw error;
  return snapshotFromRows(data);
}

async function getDoc(ref) {
  const { data, error } = await supabase.from(ref.table).select('*').eq('id', ref.id).maybeSingle();
  if (error) throw error;
  return {
    exists() { return !!data; },
    id: ref.id,
    data() { return data ? fromDbRow(data) : {}; }
  };
}

async function addDoc(collectionRef, data) {
  const { data: row, error } = await supabase.from(collectionRef.table).insert(toDbObject(data)).select('id').single();
  if (error) throw error;
  return { id: row.id };
}

async function setDoc(ref, data, options) {
  const payload = { ...toDbObject(data), id: ref.id };
  const { error } = await supabase.from(ref.table).upsert(payload, { onConflict: 'id' });
  if (error) throw error;
}

async function updateDoc(ref, data) {
  const { error } = await supabase.from(ref.table).update(toDbObject(data)).eq('id', ref.id);
  if (error) throw error;
}

async function deleteDoc(ref) {
  const { error } = await supabase.from(ref.table).delete().eq('id', ref.id);
  if (error) throw error;
}

// Kept as a compatibility surface only. New atomic operations should use
// Postgres functions/RPCs rather than pretending a browser transaction exists.
async function runTransaction() {
  throw new Error('Browser transactions are not used in the Supabase build. Use a Postgres RPC for atomic operations.');
}

// Firebase-shaped auth wrapper so the existing portal can migrate safely.
const auth = { __kind: 'supabase-auth' };
const secondaryAuth = { __kind: 'supabase-secondary-auth' };

async function createUserWithEmailAndPassword(_auth, email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw normalizeAuthError(error);
  if (!data.user) throw new Error('The account could not be created.');
  return { user: data.user };
}

async function signInWithEmailAndPassword(_auth, email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw normalizeAuthError(error);
  return { user: data.user };
}

async function signOut(_auth) {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
}

function onAuthStateChanged(_auth, callback) {
  supabase.auth.getSession().then(({ data }) => callback(data.session ? data.session.user : null));
  const { data } = supabase.auth.onAuthStateChange((_event, session) => {
    callback(session ? session.user : null);
  });
  return function unsubscribe() {
    try { data.subscription.unsubscribe(); } catch (_) {}
  };
}

async function deleteUser() {
  throw new Error('Client-side user deletion is intentionally disabled. Use a protected server-side workflow.');
}

function normalizeAuthError(error) {
  if (!error) return error;
  const message = error.message || '';
  if (/already registered|already exists/i.test(message)) error.code = 'auth/email-already-in-use';
  else if (/invalid login credentials/i.test(message)) error.code = 'auth/invalid-credential';
  else if (/password.*(weak|at least)/i.test(message)) error.code = 'auth/weak-password';
  else if (/invalid.*email/i.test(message)) error.code = 'auth/invalid-email';
  else if (/rate limit|too many/i.test(message)) error.code = 'auth/too-many-requests';
  return error;
}

window.mripSupabase = supabase;
window.mripDb = {
  db: supabase,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  runTransaction
};
window.mripAuth = {
  auth,
  secondaryAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  deleteUser,
  supabase
};

window.dispatchEvent(new Event('mripDbReady'));

// Expose a simple diagnostic marker so the portal can distinguish
// initialization from a failed external-library load.
window.MAHDU_SUPABASE_READY = true;
