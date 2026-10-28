import tables from './resources/native-charset-models.json' with { type: 'json' };

const f32 = Math.fround;
const DETECTING = 0, FOUND = 1, NOT_ME = 2;
const SURE = f32(0.99), UNSURE = f32(0.01), SHORTCUT = f32(0.95);
const matrices = new Map(Object.entries(tables.matrices).map(([key, value]) => [key, Buffer.from(value, 'base64')]));
const sequences = tables.sequences.map(model => model.kind === 'Hebrew' ? model : {
  ...model, ratio: f32(model.ratio), orders: Buffer.from(model.orders, 'base64'), matrix: matrices.get(model.matrix),
});
const japaneseContext = Buffer.from(tables.japaneseContext, 'base64');
const latinClasses = Buffer.from(tables.latinClasses, 'base64'), latinModel = Buffer.from(tables.latinModel, 'base64');
const isLetter = b => b >= 0x41 && b <= 0x5a || b >= 0x61 && b <= 0x7a;

function filterWithoutEnglish(bytes) {
  const output = [], append = (start, end) => { for (let i = start; i < end; i++) output.push(bytes[i]); };
  let high = false, previous = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b & 0x80) high = true;
    else if (!isLetter(b)) {
      if (high && i > previous) { append(previous, i); output.push(0x20); high = false; }
      previous = i + 1;
    }
  }
  if (high && bytes.length > previous) append(previous, bytes.length);
  return output;
}

function filterWithEnglish(bytes) {
  const output = [], append = (start, end) => { for (let i = start; i < end; i++) output.push(bytes[i]); };
  let inTag = false, previous = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x3e) inTag = false;
    else if (b === 0x3c) inTag = true;
    if (!(b & 0x80) && !isLetter(b)) {
      if (i > previous && !inTag) { append(previous, i); output.push(0x20); }
      previous = i + 1;
    }
  }
  if (!inTag && bytes.length > previous) append(previous, bytes.length);
  return output;
}

class SingleByteProber {
  state = DETECTING;
  last = 255;
  totalSequences = 0;
  counts = [0, 0, 0, 0];
  total = 0;
  controls = 0;
  frequent = 0;
  constructor(model) { this.model = model; }
  feed(bytes) {
    const model = this.model;
    for (const b of bytes) {
      const order = model.orders[b];
      if (order < 250) this.total++;
      else if (order === 255) { this.state = NOT_ME; break; }
      else if (order === 254) this.controls++;
      if (order < model.count) {
        this.frequent++;
        if (this.last < model.count) {
          this.totalSequences++;
          const index = model.reversed ? order * model.count + this.last : this.last * model.count + order;
          this.counts[model.matrix[index]]++;
        }
      }
      this.last = order;
    }
    if (this.state === DETECTING && this.totalSequences > 1024) {
      const confidence = this.confidence();
      if (confidence > SHORTCUT) this.state = FOUND;
      else if (confidence < f32(0.05)) this.state = NOT_ME;
    }
    return this.state;
  }
  confidence() {
    if (!this.totalSequences) return UNSURE;
    let result = f32(f32(this.counts[3] / this.totalSequences) / this.model.ratio);
    result = f32(f32(result * f32(this.counts[3] + f32(this.counts[2] / 4))) / this.total);
    result = f32(f32(result * (this.total - this.controls)) / this.total);
    result = f32(f32(result * this.frequent) / this.total);
    return result >= 1 ? SURE : result;
  }
  name() { return this.hebrew ? this.hebrew.name() : this.model.name; }
}

class HebrewProber {
  previous = 0x20;
  beforePrevious = 0x20;
  logicalScore = 0;
  visualScore = 0;
  get state() { return this.logical.state === NOT_ME && this.visual.state === NOT_ME ? NOT_ME : DETECTING; }
  feed(bytes) {
    if (this.state === NOT_ME) return NOT_ME;
    const final = b => b === 0xea || b === 0xed || b === 0xef || b === 0xf3 || b === 0xf5;
    const nonFinal = b => b === 0xeb || b === 0xee || b === 0xf0 || b === 0xf4;
    for (const b of bytes) {
      if (b === 0x20) {
        if (this.beforePrevious !== 0x20) {
          if (final(this.previous)) this.logicalScore++;
          else if (nonFinal(this.previous)) this.visualScore++;
        }
      } else if (this.beforePrevious === 0x20 && final(this.previous)) this.visualScore++;
      this.beforePrevious = this.previous;
      this.previous = b;
    }
    return DETECTING;
  }
  confidence() { return 0; }
  name() {
    const finals = this.logicalScore - this.visualScore;
    if (finals >= 5) return 'windows-1255';
    if (finals <= -5) return 'iso-8859-8';
    const models = f32(this.logical.confidence() - this.visual.confidence());
    if (models > UNSURE) return 'windows-1255';
    if (models < -UNSURE || finals < 0) return 'iso-8859-8';
    return 'windows-1255';
  }
}

class CodingMachine {
  state = 0;
  length = 0;
  constructor(model) { this.model = model; }
  feed(byte) {
    const type = this.model.classes[byte];
    if (this.state === 0) this.length = this.model.lengths[type];
    this.state = this.model.states[this.state * this.model.factor + type];
    return this.state;
  }
}

function distributionOrder(kind, high, low) {
  switch (kind) {
    case 'SJISProber': {
      let order;
      if (high >= 0x81 && high <= 0x9f) order = 188 * (high - 0x81);
      else if (high >= 0xe0 && high <= 0xef) order = 188 * (high - 0xe0 + 31);
      else return -1;
      return order + low - 0x40 - (low > 0x7f ? 1 : 0);
    }
    case 'EUCJPProber': return high >= 0xa0 ? 94 * (high - 0xa1) + low - 0xa1 : -1;
    case 'GB18030Prober': return high >= 0xb0 && low >= 0xa1 ? 94 * (high - 0xb0) + low - 0xa1 : -1;
    case 'EUCKRProber': case 'CP949Prober': return high >= 0xb0 ? 94 * (high - 0xb0) + low - 0xa1 : -1;
    case 'Big5Prober': return high < 0xa4 ? -1 : 157 * (high - 0xa4) + (low >= 0xa1 ? low - 0xa1 + 63 : low - 0x40);
    case 'EUCTWProber': return high >= 0xc4 ? 94 * (high - 0xc4) + low - 0xa1 : -1;
    default: throw new Error('Unrecognized native distribution model.');
  }
}

class DistributionAnalyser {
  total = 0;
  frequent = 0;
  constructor(model) { this.model = model; this.ratio = f32(model.distribution.ratio); }
  feed(high, low, length) {
    const order = length === 2 ? distributionOrder(this.model.kind, high, low) : -1;
    if (order < 0) return;
    this.total++;
    if (order < this.model.distribution.orders.length && this.model.distribution.orders[order] < 512) this.frequent++;
  }
  confidence() {
    if (!this.total || this.frequent <= 4) return UNSURE;
    if (this.total !== this.frequent) {
      const ratio = f32(this.frequent / f32((this.total - this.frequent) * this.ratio));
      if (ratio < SURE) return ratio;
    }
    return SURE;
  }
  enough() { return this.total > 1024; }
}

class JapaneseAnalyser {
  total = 0;
  counts = [0, 0, 0, 0, 0, 0];
  last = -1;
  constructor(kind) { this.kind = kind; }
  feed(high, low, length) {
    if (this.total > 1000) return;
    let order = -1;
    if (length === 2) {
      if (this.kind === 'SJISProber' && high === 0x82 && low >= 0x9f && low <= 0xf1) order = low - 0x9f;
      else if (this.kind === 'EUCJPProber' && high === 0xa4 && low >= 0xa1 && low <= 0xf3) order = low - 0xa1;
    }
    if (order !== -1 && this.last !== -1) {
      this.total++;
      this.counts[japaneseContext[this.last * tables.japaneseWidth + order]]++;
    }
    this.last = order;
  }
  enough() { return this.total > 100; }
  confidence() { return this.total > 4 ? f32((this.total - this.counts[0]) / this.total) : -1; }
}

class MultiByteProber {
  state = DETECTING;
  last = 0;
  characters = 0;
  constructor(model) {
    this.model = model;
    this.machine = new CodingMachine(model.machine);
    if (model.distribution) this.distribution = new DistributionAnalyser(model);
    if (model.kind === 'SJISProber' || model.kind === 'EUCJPProber') this.context = new JapaneseAnalyser(model.kind);
  }
  feed(bytes) {
    for (let i = 0; i < bytes.length; i++) {
      const state = this.machine.feed(bytes[i]);
      if (state === 1) { this.state = NOT_ME; break; }
      if (state === 2) { this.state = FOUND; break; }
      if (state !== 0) continue;
      const length = this.machine.length;
      if (this.model.kind === 'UTF8Prober') {
        if (length >= 2) this.characters++;
        continue;
      }
      this.distribution.feed(i === 0 ? this.last : bytes[i - 1], bytes[i], length);
      if (this.context) {
        // SJIS passes a character-length-aligned slice to context; EUCJP
        // always passes the previous two bytes, including its three-byte case.
        const start = this.model.kind === 'SJISProber' ? i + 1 - length : i - 1;
        this.context.feed(i === 0 ? (length === 1 && this.model.kind === 'SJISProber' ? bytes[0] : this.last) : bytes[start],
          i === 0 ? bytes[0] : bytes[start + 1], length);
      }
    }
    if (this.model.kind !== 'UTF8Prober') this.last = bytes[bytes.length - 1];
    if (this.state === DETECTING) {
      const enough = this.model.kind === 'UTF8Prober' || (this.context ? this.context.enough() : this.distribution.enough());
      if (enough && this.confidence() > SHORTCUT) this.state = FOUND;
    }
    return this.state;
  }
  confidence() {
    if (this.model.kind === 'UTF8Prober') {
      if (this.characters >= 6) return SURE;
      let unlike = SURE;
      for (let i = 0; i < this.characters; i++) unlike = f32(unlike * 0.5);
      return f32(1 - unlike);
    }
    const distribution = this.distribution.confidence();
    return this.context ? Math.max(distribution, this.context.confidence()) : distribution;
  }
  name() { return this.model.name; }
}

class GroupProber {
  state = DETECTING;
  best = -1;
  constructor(multibyte) {
    this.multibyte = multibyte;
    this.probers = multibyte ? tables.multibyte.map(model => new MultiByteProber(model))
      : sequences.map(model => model.kind === 'Hebrew' ? new HebrewProber() : new SingleByteProber(model));
    if (!multibyte) {
      const helper = this.probers.find(prober => prober instanceof HebrewProber);
      for (const prober of this.probers) if (prober.model?.hebrew) {
        prober.hebrew = helper;
        if (prober.model.reversed) helper.visual = prober;
        else helper.logical = prober;
      }
    }
    this.active = this.probers.map(() => true);
    this.remaining = this.probers.length;
  }
  feed(bytes) {
    let filtered;
    if (this.multibyte) {
      filtered = [];
      let keepNext = true;
      for (const b of bytes) {
        if (b & 0x80) { filtered.push(b); keepNext = true; }
        else if (keepNext) { filtered.push(b); keepNext = false; }
      }
    } else filtered = filterWithoutEnglish(bytes);
    if (!this.multibyte && !filtered.length) return this.state;
    for (let i = 0; i < this.probers.length; i++) if (this.active[i]) {
      const state = this.probers[i].feed(filtered);
      if (state === FOUND) { this.best = i; this.state = FOUND; break; }
      if (state === NOT_ME) {
        this.active[i] = false;
        if (--this.remaining <= 0) { this.state = NOT_ME; break; }
      }
    }
    return this.state;
  }
  confidence() {
    if (this.state === FOUND) return SURE;
    if (this.state === NOT_ME) return UNSURE;
    let best = 0;
    for (let i = 0; i < this.probers.length; i++) if (this.active[i]) {
      const confidence = this.probers[i].confidence();
      if (best < confidence) { best = confidence; this.best = i; }
    }
    return best;
  }
  name() {
    if (this.best === -1) { this.confidence(); if (this.best === -1) this.best = 0; }
    return this.probers[this.best].name();
  }
}

class LatinProber {
  state = DETECTING;
  last = 1;
  counts = [0, 0, 0, 0];
  feed(bytes) {
    for (const b of filterWithEnglish(bytes)) {
      const type = latinClasses[b], frequency = latinModel[this.last * 8 + type];
      if (frequency === 0) { this.state = NOT_ME; break; }
      this.counts[frequency]++;
      this.last = type;
    }
    return this.state;
  }
  confidence() {
    if (this.state === NOT_ME) return UNSURE;
    const total = this.counts.reduce((sum, count) => sum + count, 0);
    const result = total ? f32(f32(this.counts[3] / total) - f32(f32(this.counts[1] * 20) / total)) : 0;
    return result < 0 ? 0 : f32(result * 0.5);
  }
  name() { return 'windows-1252'; }
}

class EscapeProber {
  state = DETECTING;
  detected = null;
  machines = tables.escape.map(model => new CodingMachine(model));
  active = tables.escape.length;
  feed(bytes) {
    for (const b of bytes) {
      if (this.state !== DETECTING) break;
      for (let j = this.active - 1; j >= 0; j--) {
        const state = this.machines[j].feed(b);
        if (state === 1) {
          if (--this.active === 0) { this.state = NOT_ME; return this.state; }
          if (j !== this.active) [this.machines[this.active], this.machines[j]] = [this.machines[j], this.machines[this.active]];
        } else if (state === 2) { this.state = FOUND; this.detected = this.machines[j].model.name; return this.state; }
      }
    }
    return this.state;
  }
  name() { return this.detected; }
}

function bomName(bytes) {
  const [a, b, c, d] = bytes;
  if (bytes.length < 2) return null;
  if (a === 0xfe && b === 0xff) return c === 0 && d === 0 ? 'X-ISO-10646-UCS-4-3412' : 'utf-16be';
  if (a === 0xff && b === 0xfe) return c === 0 && d === 0 ? 'utf-32le' : 'utf-16le';
  if (bytes.length < 3) return null;
  if (a === 0xef && b === 0xbb && c === 0xbf) return 'utf-8';
  if (bytes.length < 4) return null;
  if (a === 0 && b === 0 && c === 0xfe && d === 0xff) return 'utf-32be';
  if (a === 0 && b === 0 && c === 0xff && d === 0xfe) return 'X-ISO-10646-UCS-4-2143';
  if (a === 0x2b && b === 0x2f && c === 0x76 && [0x38, 0x39, 0x2b, 0x2f].includes(d)) return 'utf-7';
  if (a === 0x84 && b === 0x31 && c === 0x95 && d === 0x33) return 'gb18030';
  return null;
}

const detail = (name, confidence, bom = false) => ({ name, confidence, encoding: tables.encodings[name] ?? null, bom });

/** CharsetDetector.DetectFromStream feeds exactly 1024 bytes. Accumulate only
 * that feed boundary so network chunk sizes cannot change its model results. */
export function createNativeCharsetStreamDetector() {
  let inputState='ascii',last=0,probers=[],start=true,pending=Buffer.alloc(0),found=null,any=false,ended=false;
  const feed=chunk=>{
    if(found)return;
    if(start){start=false;const bom=bomName(chunk);if(bom){found={details:[detail(bom,1,true)]};return;}}
    for(const b of chunk){
      if((b&0x80)&&b!==0xa0){if(inputState!=='high'){inputState='high';probers=[new GroupProber(true),new GroupProber(false),new LatinProber()];}}
      else{if(inputState==='ascii'&&(b===0x1b||b===0x7b&&last===0x7e)){inputState='escape';probers=[new EscapeProber()];}last=b;}
    }
    for(const prober of probers)if(prober.feed(chunk)===FOUND){found={details:[detail(prober.name(),1)]};return;}
  };
  return Object.freeze({
    get done(){return found!==null;},
    append(bytes){
      if(ended)throw new Error('Charset detection has completed.');if(!(bytes instanceof Uint8Array))throw new TypeError('Charset detection requires bytes.');
      if(!bytes.length)return;any=true;if(found)return;
      let offset=0;
      if(pending.length){const take=Math.min(1024-pending.length,bytes.length);pending=Buffer.concat([pending,bytes.subarray(0,take)]);offset=take;if(pending.length===1024){feed(pending);pending=Buffer.alloc(0);}}
      while(offset+1024<=bytes.length&&!found){feed(bytes.subarray(offset,offset+1024));offset+=1024;}
      if(!found&&offset<bytes.length)pending=Buffer.from(bytes.subarray(offset));
    },
    finish(){if(ended)throw new Error('Charset detection completes exactly once.');ended=true;if(pending.length)feed(pending);pending=Buffer.alloc(0);
      if(found)return found;if(!any)return{details:null};if(inputState!=='high')return{details:[detail('ascii',1)]};
      return{details:probers.map(prober=>detail(prober.name(),prober.confidence())).filter(result=>result.confidence>f32(0.2)).sort((a,b)=>b.confidence-a.confidence)};}
  });
}

// The buffer and stream entry points are intentionally distinct: filters and
// shortcut thresholds are evaluated at native feed boundaries, not at EOF.
export function detectNativeCharset(bytes, { stream = false } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Charset detection requires bytes.');
  if (!bytes.length) return { details: null };
  let inputState = 'ascii', last = 0, probers = [], start = true;
  const size = stream ? 1024 : bytes.length;
  for (let offset = 0; offset < bytes.length; offset += size) {
    const chunk = bytes.subarray(offset, Math.min(offset + size, bytes.length));
    if (start) {
      start = false;
      const bom = bomName(chunk);
      if (bom) return { details: [detail(bom, 1, true)] };
    }
    for (const b of chunk) {
      if ((b & 0x80) && b !== 0xa0) {
        if (inputState !== 'high') { inputState = 'high'; probers = [new GroupProber(true), new GroupProber(false), new LatinProber()]; }
      } else {
        if (inputState === 'ascii' && (b === 0x1b || b === 0x7b && last === 0x7e)) {
          inputState = 'escape'; probers = [new EscapeProber()];
        }
        last = b;
      }
    }
    for (const prober of probers) if (prober.feed(chunk) === FOUND) return { details: [detail(prober.name(), 1)] };
  }
  if (inputState !== 'high') return { details: [detail('ascii', 1)] };
  return { details: probers.map(prober => {
    const confidence = prober.confidence();
    return detail(prober.name(), confidence);
  }).filter(result => result.confidence > f32(0.2)).sort((a, b) => b.confidence - a.confidence) };
}
