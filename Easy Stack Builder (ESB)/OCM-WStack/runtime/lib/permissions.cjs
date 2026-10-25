'use strict';
const atomic=['credentials.read','credentials.verify','credentials.delete','credentials.receive','credentials.issue','credentials.revoke','relationships.read','relationships.write','clearing.request','audit.read','roles.read','admin.users','system.health.read'];
const composites={viewer:['credentials.read','credentials.verify','relationships.read'],operator:['credentials.read','credentials.verify','relationships.read','credentials.receive','clearing.request','relationships.write'],issuer:['credentials.read','credentials.verify','credentials.issue','credentials.revoke'],auditor:['credentials.read','relationships.read','audit.read'],administrator:atomic};
module.exports={atomic,composites};
