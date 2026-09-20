declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "UserAccount" | "CalDavGatekeeperImpl";
  }
}
