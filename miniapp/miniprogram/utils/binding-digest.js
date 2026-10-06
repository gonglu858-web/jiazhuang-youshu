// 仅用于开发探针核对已验证的十位编号，不承担服务端身份授权。
// 输入始终是固定 AppID + ':' + 十位 ASCII 数字，SHA-256 只需一个消息块。
const initial = [], constants = [];
for (let candidate = 2; constants.length < 64; candidate++) {
  let prime = true;
  for (let divisor = 2; divisor * divisor <= candidate; divisor++) {
    if (candidate % divisor === 0) { prime = false; break; }
  }
  if (!prime) continue;
  const fraction = value => ((value - Math.floor(value)) * 0x100000000) >>> 0;
  if (initial.length < 8) initial.push(fraction(Math.sqrt(candidate)));
  constants.push(fraction(Math.pow(candidate, 1 / 3)));
}
const rotate = (word, bits) => (word >>> bits) | (word << (32 - bits));
function bindingDigest(number) {
  if (typeof number !== 'string' || !/^\d{10}$/.test(number)) throw new Error('请输入十位绑定编号。');
  const input = 'wxfb4db1615ac15531:' + number;
  const words = Array(64).fill(0);
  for (let i = 0; i < input.length; i++) words[i >> 2] |= input.charCodeAt(i) << (24 - (i % 4) * 8);
  words[input.length >> 2] |= 0x80 << (24 - (input.length % 4) * 8);
  words[15] = input.length * 8;
  for (let i = 16; i < 64; i++) {
    const x = words[i - 15], y = words[i - 2];
    const s0 = rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3);
    const s1 = rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10);
    words[i] = (words[i - 16] + s0 + words[i - 7] + s1) | 0;
  }
  let [a, b, c, d, e, f, g, h] = initial;
  for (let i = 0; i < 64; i++) {
    const sum1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
    const choose = (e & f) ^ (~e & g);
    const t1 = (h + sum1 + choose + constants[i] + words[i]) | 0;
    const sum0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
    const majority = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (sum0 + majority) | 0;
    h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
  }
  return [a, b, c, d, e, f, g, h].map((word, i) =>
    ((word + initial[i]) >>> 0).toString(16).padStart(8, '0')).join('');
}
module.exports = { bindingDigest };
