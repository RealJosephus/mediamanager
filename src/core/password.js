import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);
export const DEFAULT_ITERATIONS = 210000;
export const DEFAULT_HASH_METHOD = 'PBKDF2-SHA512';

function passwordText(value) {
  if (value===null || value===undefined) return '';
  if (typeof value!=='string') throw new TypeError('A password must be a string.');
  // Rfc2898DeriveBytes uses strict UTF-8 encoding rather than replacement fallback.
  if (!value.isWellFormed()) throw new TypeError('Password contains invalid UTF-16.');
  return value;
}

const hexBytes = value => {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new TypeError('Invalid hexadecimal password hash.');
  return Buffer.from(value,'hex');
};

export function parsePasswordHash(value) {
  if (typeof value !== 'string' || !value) throw new TypeError("String can't be empty");
  if (!value.startsWith('$')) throw new TypeError('Hash string must start with a $');
  const segments = value.slice(1).split('$');
  const id = segments.shift();
  if (!id) throw new TypeError('Hash string must contain a valid id');
  const parameters = new Map();
  if (segments[0]?.includes('=')) {
    let raw = segments.shift();
    while (raw) {
      const index = raw.indexOf(',');
      const parameter = index < 0 ? raw : raw.slice(0,index);
      raw = index < 0 ? '' : raw.slice(index+1);
      const split = parameter.indexOf('=');
      if (split < 1 || split === parameter.length-1) throw new TypeError('Malformed parameter in password hash string');
      const key = parameter.slice(0,split);
      if (parameters.has(key)) throw new TypeError('Duplicate password hash parameter');
      parameters.set(key,parameter.slice(split+1));
    }
  }
  if (segments.length>2) throw new TypeError('Hash string contains too many segments');
  if (segments.length===2 && (!segments[0] || !segments[1])) throw new TypeError('Hash string contains an empty segment');
  return {id,parameters,salt:segments.length===2?hexBytes(segments[0]):Buffer.alloc(0),hash:hexBytes(segments.at(-1)??'')};
}

export function serializePasswordHash({id,parameters=new Map(),salt=Buffer.alloc(0),hash=Buffer.alloc(0)}) {
  if (!id) throw new TypeError('Password hash ID is required.');
  let result = `$${id}`;
  if (parameters.size) result+=`$${[...parameters].map(([key,value])=>`${key}=${value}`).join(',')}`;
  if (salt.length) result+=`$${salt.toString('hex').toUpperCase()}`;
  if (hash.length) result+=`$${hash.toString('hex').toUpperCase()}`;
  return result;
}

function iterationsOf(hash) {
  const value=hash.parameters.get('iterations');
  if (value===undefined) throw new TypeError(`Password hash with id '${hash.id}' is missing required 'iterations' parameter.`);
  const match=/^[\x09-\x0d ]*([+-]?\d+)[\x09-\x0d ]*\0*$/.exec(value);
  if (!match || !Number.isInteger(Number(match[1])) || Number(match[1])<-2147483648 || Number(match[1])>2147483647) {
    throw new TypeError(`Password hash with id '${hash.id}' has invalid 'iterations' parameter.`);
  }
  const iterations=Number(match[1]);
  if (iterations<=0) throw new RangeError('Iterations must be positive.');
  return iterations;
}

export async function verifyPasswordHash(hash,password) {
  if (![DEFAULT_HASH_METHOD,'PBKDF2'].includes(hash.id)) throw new TypeError(`Can't verify hash with id: ${hash.id}`);
  const iterations=iterationsOf(hash);
  const actual=await derive(passwordText(password),hash.salt,iterations,hash.id==='PBKDF2'?32:64,hash.id==='PBKDF2'?'sha1':'sha512');
  return hash.hash.length===actual.length && timingSafeEqual(hash.hash,actual);
}

export async function createPasswordHash(password) {
  const salt=randomBytes(16);
  return serializePasswordHash({id:DEFAULT_HASH_METHOD,parameters:new Map([['iterations',String(DEFAULT_ITERATIONS)]]),salt,
    hash:await derive(passwordText(password),salt,DEFAULT_ITERATIONS,64,'sha512')});
}

export async function authenticatePassword(username,password,user) {
  if (!user) throw new Error('Invalid username or password');
  if (!user.Password && !password) return {Username:username};
  if (user.Password===null || user.Password===undefined) throw new Error('Invalid username or password');
  const hash=parsePasswordHash(user.Password);
  if (!await verifyPasswordHash(hash,password)) throw new Error('Invalid username or password');
  if (hash.id!==DEFAULT_HASH_METHOD || iterationsOf(hash)!==DEFAULT_ITERATIONS) user.Password=await createPasswordHash(password);
  return {Username:username};
}
