import test from 'node:test';
import assert from 'node:assert/strict';
import {formatComposite} from '../../src/core/composite-format.js';
import {createCoreLocalization,Localization} from '../../src/core/i18n.js';

test('core composite formatting retains indexed values, escaped braces and alignment',async()=>{
  assert.equal(formatComposite('{{{1,-4}}} {0,3}',[2,'A']),'{A   }   2');
  assert.equal(formatComposite('{0}/{1}',[null,true]),'/True');
  assert.throws(()=>formatComposite('{1}',['a']),/missing/);
  assert.throws(()=>formatComposite('{0:unknown}',['a']),/Unsupported/);
  const localization=await createCoreLocalization();
  assert.equal(localization.format('NameSeasonNumber',[2]),'Season 2');
  assert.equal(localization.diagnostics.length,0);
});

test('invalid message format diagnostics preserve the actual message',()=>{
  const localization=new Localization();
  localization.register('plugin',{message:'Value {broken}'});
  assert.equal(localization.diagnostics.length,1);
  assert.equal(localization.text('message',{namespace:'plugin'}),'Value {broken}');
});
