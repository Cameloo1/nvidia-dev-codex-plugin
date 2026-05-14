async function start() {
  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const decoder = new VideoDecoder({ output() {}, error() {} });
  console.log(device, decoder);
}

start();
