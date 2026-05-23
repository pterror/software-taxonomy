{
  description = "Cladistic taxonomy of software";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        # ascent-interpreter binary — built from ~/git/ascent-interpreter via `cargo build --release`
        # The flake input approach requires a packages output from that flake; for now, wrap the
        # pre-built binary directly. Update when ascent-interpreter exposes packages.${system}.default.
        ascentInterpreterBin = pkgs.runCommand "ascent-interpreter-bin" {} ''
          mkdir -p $out/bin
          cp /home/me/git/ascent-interpreter/target/release/ascent-interpreter $out/bin/ascent-interpreter
          chmod +x $out/bin/ascent-interpreter
        '';
      in
      {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            bun
            jq
            ascentInterpreterBin
          ];
        };
      }
    );
}
