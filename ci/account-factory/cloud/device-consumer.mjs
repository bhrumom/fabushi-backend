import { randomBytes } from 'node:crypto';

// Real canonical cloud control-plane calls; no target Host execution is claimed.
export const deviceAssertions = [
  'cloudDeviceRegistration','deviceRegistrationIdempotent','sameAccountDeviceInventory',
  'crossAccountDeviceInventory','crossAccountRegistrationDenied','crossAccountHeartbeatDenied',
  'sameAccountPairAndSession','remoteSessionReconcile','crossAccountSessionDenied',
  'revokedDeviceApisDenied','deletedDeviceApisDenied','abandonedDeviceRegistered',
];

export function deviceConsumer({auth,check}) {
  const request = async(path,session,body,status=200) => {
    const response=await auth(path,session,body);
    if(response.status!==status){await response.body?.cancel();throw Error('device_consumer_http_failed');}
    return response.json();
  };
  const registration = (account,index=0) => ({deviceId:account.deviceIds[index],
    deviceSecret:randomBytes(32).toString('hex'),label:'CI API fixture; no target runtime',
    provider:'fabushi-webrtc',platform:'linux',appVersion:'ci-control-plane',capabilities:[]});
  async function denied(session,device,id) {
    const paths=[['/v1/computers',undefined],['/v1/computers/register',device],
      ['/v1/computers/heartbeat',{deviceId:device.deviceId,deviceSecret:device.deviceSecret}]];
    for(const [path,body] of paths)await request(path,session,body,401);
    check(true,id);
  }
  return {
    async exercise(accounts) {
      const [a,b,c]=accounts,devices=[registration(a),registration(a,1),registration(b),registration(c)];
      let registered;
      for(const [index,device] of devices.entries()) {
        const owner=index<2?a:index===2?b:c;
        const body=await request('/v1/computers/register',owner.sessions[0],device);
        check(body.deviceId===device.deviceId,'cloudDeviceRegistration');
      }
      registered=await request('/v1/computers/register',a.sessions[0],devices[0]);
      const listA=await request('/v1/computers',a.sessions[1]);
      check(listA.computers.length===2&&new Set(listA.computers.map(x=>x.deviceId)).size===2,'deviceRegistrationIdempotent');
      check(devices.slice(0,2).every(d=>listA.computers.some(x=>x.deviceId===d.deviceId)),'sameAccountDeviceInventory');
      const listB=await request('/v1/computers',b.sessions[0]);
      check(listB.computers.length===1&&listB.computers[0].deviceId===devices[2].deviceId,'crossAccountDeviceInventory');
      await request('/v1/computers/register',b.sessions[0],devices[0],403);check(true,'crossAccountRegistrationDenied');
      await request('/v1/computers/heartbeat',b.sessions[0],{deviceId:devices[0].deviceId,deviceSecret:devices[0].deviceSecret},404);check(true,'crossAccountHeartbeatDenied');
      const paired=await request('/v1/computers/pair',a.sessions[1],{pairingCode:registered.pairingCode,label:'CI account controller'});
      const sessionBody={clientId:paired.clientId,clientToken:paired.clientToken,requestId:'ci-session-'+randomBytes(16).toString('hex')};
      const prefix=`/v1/computers/${devices[0].deviceId}/sessions`;
      const session=await request(prefix,a.sessions[1],sessionBody);
      check(typeof session.sessionId==='string'&&session.state==='pending','sameAccountPairAndSession');
      const reconciled=await request(prefix+'/reconcile',a.sessions[1],sessionBody);
      check(reconciled.sessionId===session.sessionId&&reconciled.mobileToken===session.mobileToken,'remoteSessionReconcile');
      await request(prefix,b.sessions[0],sessionBody,403);check(true,'crossAccountSessionDenied');
      return devices;
    },
    denied,
    async abandon(account) {
      await request('/v1/computers/register',account.sessions[0],registration(account));
      check(true,'abandonedDeviceRegistered');
    },
  };
}
