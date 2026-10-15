import { parseLosslessJson } from '../../src/core/json.js';

export async function recordPlaybackBinding(origin, inputs) {
  const baseHeaders = { Authorization:'MediaBrowser Client="BindingOracle", Device="Isolated", DeviceId="binding-oracle", Version="1"','Content-Type':'application/json' };
  const login=await fetch(origin+'/Users/AuthenticateByName',{method:'POST',headers:baseHeaders,body:'{"Username":"CoreFlowAdmin","Pw":"isolated-core-flow-password"}'});
  const user=await login.json();if(!user.AccessToken)throw new Error('Isolated binding login failed.');
  const headers={...baseHeaders,Authorization:baseHeaders.Authorization+`, Token="${user.AccessToken}"`};
  const records=[];
  for(const input of inputs) {
    const response=await fetch(origin+'/Items/22222222222222222222222222222222/PlaybackInfo'+(input.query??''),{method:'POST',headers,body:input.json});
    const text=await response.text();let body=text;try{body=parseLosslessJson(text);}catch{}
    records.push({name:input.name,status:response.status,body});
  }
  return records;
}
