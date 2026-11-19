'use strict';
// Isolated fake browser for batch integration tests; never connects to the website.
function fakeSession(accountId,equipmentId,profileId='17',onClose=()=>{}){
 let url=`https://healthlab.zs-hospital.sh.cn/cf/main/!equipments/equipment/index.${equipmentId}.reserv`,closed=false;
 const page={url:()=>url,goto:async value=>{if(closed)throw Error('browser closed');url=value;},isClosed:()=>closed,setEquipment:id=>{url=`https://healthlab.zs-hospital.sh.cn/cf/main/!equipments/equipment/index.${id}.reserv`;},locator:()=>({waitFor:async()=>{if(closed)throw Error('page closed');},getAttribute:async()=>'/cf/main/!people/profile/index.'+profileId})};
 return{page,accountId,browser:{isConnected:()=>!closed,close:async()=>{if(!closed){closed=true;onClose();}}}};
}
module.exports={fakeSession};
