export function startWorker() {
  return {
    service: "affiliate-automation-worker",
    status: "ready",
  };
}

if (process.env.NODE_ENV !== "test") {
  console.log(startWorker());
}
