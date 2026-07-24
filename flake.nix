{
  description = "costthing — shared Jellyfin server cost dashboard";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAllSystems (pkgs: rec {
        costthing = pkgs.callPackage ./nix/package.nix { };
        frontend = costthing.frontend;
        default = costthing;
      });

      checks = nixpkgs.lib.genAttrs systems (system: {
        default = self.packages.${system}.default;
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ pkgs.deno ];
        };
      });
    };
}
