const BandwidthRtc = require("bandwidth-rtc/dist/webpackIndex.js");
const { EndpointType } = require("bandwidth-rtc/dist/types.js");

const bandwidthRtc = new BandwidthRtc("debug");

window.bandwidthRtc = bandwidthRtc;
window.EndpointType = EndpointType;

console.log("BandwidthRtc instance:", bandwidthRtc);
console.log("EndpointType:", EndpointType);