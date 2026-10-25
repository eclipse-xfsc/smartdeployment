'use strict';
// Values match the pinned official charts. Jaeger 4 uses its native v2 config;
// the former allInOne/storage chart fields no longer configure the process.
function values(c){return {
 // Let Kubernetes/CSI apply the PVC group permissions. The optional BusyBox
 // chown init container can fail in the runtime before Grafana ever starts.
 monitoring:{grafana:{initChownData:{enabled:false},securityContext:{runAsNonRoot:true,runAsUser:472,runAsGroup:472,fsGroup:472,fsGroupChangePolicy:'Always'},persistence:{enabled:true,storageClassName:c.actualStorageClass,size:'5Gi'},'grafana.ini':{server:{root_url:'https://grafana.'+c.domain}}}},
 jaeger:{userconfig:{
  service:{extensions:['jaeger_storage','jaeger_query','healthcheckv2'],pipelines:{traces:{receivers:['otlp'],processors:['batch'],exporters:['jaeger_storage_exporter']}}},
  extensions:{healthcheckv2:{use_v2:true,http:{endpoint:'0.0.0.0:13133'}},jaeger_query:{storage:{traces:'primary_store'}},jaeger_storage:{backends:{primary_store:{memory:{max_traces:100000}}}}},
  receivers:{otlp:{protocols:{grpc:{endpoint:'0.0.0.0:4317'},http:{endpoint:'0.0.0.0:4318'}}}},processors:{batch:{}},exporters:{jaeger_storage_exporter:{trace_storage:'primary_store'}}
 }}
};}
module.exports={values};
