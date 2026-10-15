// ユーザが正当に setInterval / clearInterval を使うプログラム。
// debugProtectionInterval > 0 の起動部と取り違えないことの検査。
var ticks = 0;
var handle = setInterval(function () {
  ticks += 1;
  if (ticks >= 3) {
    clearInterval(handle);
    console.log('ticks=' + ticks);
  }
}, 1);
