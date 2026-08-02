{
  lib,
  stdenvNoCC,
  deno,
  makeWrapper,
  version ? "0.1.0",
  denoDepsHashes ? {
    aarch64-darwin = "sha256-yAZnzprosmsv3+1ejbEFr6Wyq511IJVEl7ddHFpNxDw=";
    x86_64-darwin = "sha256-psttU5irzBFfQesXLlw14r1+a/WRSARUjt3Y7iHujyA=";
    aarch64-linux = "sha256-dp/UXoz4lr23kqJ0YUUqEp0m57uz1278nSXNWTEK6c4=";
    x86_64-linux = "sha256-eXWrbkmqX1DKVgAye7Js8sc9YFdI2JQYiE3+hrse1kI=";
  },
}:

let
  system = stdenvNoCC.hostPlatform.system;
  targetOS = if stdenvNoCC.hostPlatform.isDarwin then "darwin" else "linux";
  targetArch = if stdenvNoCC.hostPlatform.isAarch64 then "arm64" else "x64";

  dependencySource = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../deno.json
      ../deno.lock
    ];
  };

  projectSource = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.unions [
      ../deno.json
      ../deno.lock
      ../frontend/index.html
      ../frontend/public
      ../frontend/src
      ../frontend/svelte.config.js
      ../frontend/tsconfig.json
      ../frontend/vite.config.ts
      ../shared
      ../src
    ];
  };

  denoDeps = stdenvNoCC.mkDerivation {
    pname = "costthing-deno-dependencies";
    inherit version;
    src = dependencySource;

    nativeBuildInputs = [ deno ];
    dontConfigure = true;

    buildPhase = ''
      runHook preBuild
      export DENO_DIR=$TMPDIR/deno-cache
      deno install --os ${targetOS} --arch ${targetArch} --frozen
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      mkdir -p $out
      rm -f node_modules/.deno/.setup-cache.bin node_modules/.deno/.deno.lock
      cp -a node_modules $out/node_modules
      runHook postInstall
    '';

    outputHashMode = "recursive";
    outputHashAlgo = "sha256";
    outputHash = denoDepsHashes.${system};
  };

  frontend = stdenvNoCC.mkDerivation {
    pname = "costthing-frontend";
    inherit version;
    src = projectSource;

    nativeBuildInputs = [ deno ];
    dontConfigure = true;

    buildPhase = ''
      runHook preBuild
      ln -s ${denoDeps}/node_modules node_modules
      export DENO_DIR=$TMPDIR/deno-cache
      deno run --cached-only --node-modules-dir=manual -A vite build frontend
      runHook postBuild
    '';

    installPhase = ''
      runHook preInstall
      cp -r frontend/dist $out
      runHook postInstall
    '';
  };
in
stdenvNoCC.mkDerivation {
  pname = "costthing";
  inherit version;
  src = projectSource;

  nativeBuildInputs = [ makeWrapper ];
  dontBuild = true;

  installPhase = ''
    runHook preInstall

    app=$out/share/costthing
    mkdir -p $app $out/bin
    cp -r deno.json deno.lock shared src $app/
    ln -s ${denoDeps}/node_modules $app/node_modules
    cp -r ${frontend} $app/frontend

    makeWrapper ${deno}/bin/deno $out/bin/costthing \
      --add-flags "run --cached-only --frozen --no-prompt --config $app/deno.json --node-modules-dir=manual --allow-env --allow-net --allow-read --allow-write $app/src/main.ts" \
      --set-default DATA_FILE "./data/costs.json" \
      --set STATIC_DIR "$app/frontend"

    runHook postInstall
  '';

  passthru = { inherit frontend; };

  meta = {
    description = "Shared Jellyfin server cost dashboard";
    homepage = "https://github.com/zekurio/costthing";
    license = lib.licenses.mit;
    mainProgram = "costthing";
  };
}
