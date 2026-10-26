/* 生成指向 launcher.exe 的 Windows 快捷方式（.lnk）
 * 为什么需要：本机 WorkBuddy 会话注入 ELECTRON_RUN_AS_NODE=1，直接运行
 * DevAI Studio.exe 会退化成纯 node（无窗口秒退）；launcher.exe 负责剥掉该变量。
 * 沙箱禁止 COM（WScript.Shell），故按 Shell Link 二进制格式手写 .lnk。
 * 用法：node scripts/make_lnk.js <输出.lnk> <目标> <工作目录> [图标路径] [名称]
 */
const fs = require('node:fs');

function countedString(s) {
  const b = Buffer.from(s, 'ascii');
  const out = Buffer.alloc(2 + b.length);
  out.writeUInt16LE(b.length, 0);
  b.copy(out, 2);
  return out;
}

function makeLnk({ target, workDir, iconPath, name }) {
  const CLSID = Buffer.from([0x01, 0x14, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46]);

  const HAS_LINK_INFO = 0x2, HAS_NAME = 0x4, HAS_RELATIVE = 0x8, HAS_WORKDIR = 0x10, HAS_ICON = 0x40;
  const flags = HAS_LINK_INFO | HAS_NAME | HAS_RELATIVE | HAS_WORKDIR | (iconPath ? HAS_ICON : 0);

  /* ---- LinkInfo ---- */
  const volLabel = Buffer.from([0x00]);                 // 空卷标（仅 null 结尾）
  const volumeID = Buffer.alloc(16 + volLabel.length);
  volumeID.writeUInt32LE(16 + volLabel.length, 0);      // VolumeIDSize
  volumeID.writeUInt32LE(3, 4);                         // DriveType = DRIVE_FIXED
  volumeID.writeUInt32LE(0, 8);                         // DriveSerialNumber
  volumeID.writeUInt32LE(0x10, 12);                     // VolumeLabelOffset
  volLabel.copy(volumeID, 16);

  const basePath = Buffer.from(target + '\0', 'ascii');
  const volOffset = 28;                                  // LinkInfo 头 28 字节
  const baseOffset = volOffset + volumeID.length;
  const linkInfoSize = baseOffset + basePath.length;

  const linkInfo = Buffer.alloc(linkInfoSize);
  linkInfo.writeUInt32LE(linkInfoSize, 0);
  linkInfo.writeUInt32LE(0x1C, 4);                      // LinkInfoHeaderSize
  linkInfo.writeUInt32LE(0x1, 8);                       // VolumeIDAndLocalBasePath
  linkInfo.writeUInt32LE(volOffset, 12);
  linkInfo.writeUInt32LE(baseOffset, 16);
  linkInfo.writeUInt32LE(0, 20);                        // CommonNetworkRelativeLinkOffset
  linkInfo.writeUInt32LE(0, 24);                        // CommonPathSuffixOffset
  volumeID.copy(linkInfo, volOffset);
  basePath.copy(linkInfo, baseOffset);

  /* ---- StringData（按 flag 位序） ---- */
  const relPath = target.split('\\').pop();
  const strings = Buffer.concat([
    countedString(name || 'DevAI Studio'),
    countedString(relPath),
    countedString(workDir),
    ...(iconPath ? [countedString(iconPath)] : []),
  ]);

  /* ---- Header ---- */
  const header = Buffer.alloc(76);
  header.writeUInt32LE(0x4C, 0);
  CLSID.copy(header, 4);
  header.writeUInt32LE(flags, 20);
  header.writeUInt32LE(0x20, 24);                       // FILE_ATTRIBUTE_ARCHIVE
  header.writeUInt32LE(0, 52);                          // FileSize
  header.writeInt32LE(0, 56);                           // IconIndex
  header.writeUInt32LE(1, 60);                          // ShowCommand = SW_SHOWNORMAL

  return Buffer.concat([header, linkInfo, strings, Buffer.from([0, 0, 0, 0])]);
}

const [, , outPath, target, workDir, iconPath, name] = process.argv;
if (!outPath || !target || !workDir) {
  console.error('usage: node make_lnk.js <out.lnk> <target> <workDir> [icon] [name]');
  process.exit(1);
}
fs.writeFileSync(outPath, makeLnk({ target, workDir, iconPath, name }));
console.log('created:', outPath, '->', target);
