// afterPack hook: ad-hoc sign the macOS app so Gatekeeper shows the ordinary
// "unidentified developer" right-click -> Open prompt instead of "damaged".
// No Apple Developer account required. No-op on non-mac build hosts
// (codesign only exists on macOS).
const { execSync } = require("child_process");
const path = require("path");

exports.default = async function afterPack(context) {
  if (process.platform !== "darwin") {
    console.log("after-pack: not on macOS, skipping ad-hoc codesign");
    return;
  }
  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`
  );
  console.log(`after-pack: ad-hoc signing ${appPath}`);
  execSync(`codesign --force --deep --sign - "${appPath}"`, {
    stdio: "inherit",
  });
};
