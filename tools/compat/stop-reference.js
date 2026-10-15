import { randomBytes } from 'node:crypto';
const base = process.argv[2];
if (!base || new URL(base).hostname !== '127.0.0.1') throw new Error('An isolated loopback URL is required.');
const existing=await fetch(new URL('/Startup/User',base));
if (!existing.ok) throw new Error(`Reference setup read failed: ${existing.status}`);
const user=await existing.json();
const password=randomBytes(24).toString('base64url');
const update=await fetch(new URL('/Startup/User',base),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({Name:user.Name,Password:password})});
if (!update.ok) throw new Error(`Reference isolated password setup failed: ${update.status}`);
const login=await fetch(new URL('/Users/AuthenticateByName',base),{method:'POST',headers:{'Content-Type':'application/json',
  Authorization:'MediaBrowser Client="CompatibilityValidation", Device="IsolatedFixture", DeviceId="fixture-oracle", Version="1.0"'},
body:JSON.stringify({Username:user.Name,Pw:password})});
if (!login.ok) throw new Error(`Reference isolated login failed: ${login.status}`);
const authentication=await login.json();
const response=await fetch(new URL('/System/Shutdown',base),{method:'POST',headers:{Authorization:`MediaBrowser Token="${authentication.AccessToken}"`}});
if (!response.ok) throw new Error(`Reference shutdown failed: ${response.status}`);
console.log(JSON.stringify({isolatedUserInitialized:true,loginVerified:true,shutdownStatus:response.status}));
