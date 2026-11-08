#!/bin/zsh

set -eu

readonly plugin_name='fm-pcc-router'
readonly marker_name=".$plugin_name-owned"
readonly marker_value="$plugin_name installer ownership marker v1"
readonly source_dirs=(integrations integrations/opencode src)
readonly source_files=(
  LICENSE package.json cli.mjs
  integrations/opencode/index.js integrations/opencode/manage.zsh
  integrations/opencode/automatic.mjs integrations/opencode/plugin.mjs
  src/bridge.mjs src/routing.mjs src/session.mjs src/strategies.mjs src/terminal.mjs
)
staging_dir=''

cleanup_stage() {
  if [[ -n "$staging_dir" ]]; then rm -rf -- "$staging_dir"; fi
}

fail() {
  print -u2 -- "FM PCC Router (OpenCode): $1"
  exit 1
}

config_root=${XDG_CONFIG_HOME:-${HOME:?HOME is not set}/.config}/opencode
plugins_dir="$config_root/plugins"
destination="$plugins_dir/$plugin_name"
script_dir=${0:A:h}
project_root=${script_dir:h:h}

has_owner_marker() {
  [[ -f "$destination/$marker_name" && ! -L "$destination/$marker_name" ]] || return 1
  [[ "$(<"$destination/$marker_name")" == "$marker_value" ]]
}

check_owned_contents() {
  local rel
  has_owner_marker || fail "Refusing to remove '$destination': its ownership marker is missing or invalid."
  for rel in "$marker_name" $source_files; do
    [[ -f "$destination/$rel" && ! -L "$destination/$rel" ]] || fail "Refusing to remove '$destination': expected owned file '$rel' is missing or is a symlink."
  done
  for rel in $source_dirs; do
    [[ -d "$destination/$rel" && ! -L "$destination/$rel" ]] || fail "Refusing to remove '$destination': an owned directory is missing or is a symlink."
  done
  local -a actual expected
  local expected_entry found
  actual=("$destination"/**/*(DN))
  expected=("$destination/$marker_name")
  if [[ -e "$destination/.DS_Store" ]]; then
    [[ -f "$destination/.DS_Store" && ! -L "$destination/.DS_Store" ]] || fail "Refusing to remove '$destination': .DS_Store is not a regular file."
    expected+=("$destination/.DS_Store")
  fi
  for rel in $source_files $source_dirs; do expected+=("$destination/$rel"); done
  (( ${#actual} == ${#expected} )) || fail "Refusing to remove '$destination': it contains unexpected files."
  for rel in $actual; do
    [[ -f "$rel" || -d "$rel" ]] || fail "Refusing to remove '$destination': it contains a special file."
    found=no
    for expected_entry in $expected; do
      [[ "$rel" == "$expected_entry" ]] && found=yes
    done
    [[ "$found" == yes ]] || fail "Refusing to remove '$destination': it contains unexpected content."
  done
}

install_plugin() {
  local rel stage
  for rel in $source_files; do
    [[ -f "$project_root/$rel" && ! -L "$project_root/$rel" ]] || fail "Install source is incomplete: '$rel' is missing or is a symlink."
  done
  for rel in $source_dirs; do
    [[ -d "$project_root/$rel" && ! -L "$project_root/$rel" ]] || fail "Install source is incomplete: '$rel' is missing or is a symlink."
  done

  [[ ! -L "$config_root" ]] || fail "Refusing to use symlinked OpenCode config directory '$config_root'."
  mkdir -p "$config_root" || fail "Could not create OpenCode config directory '$config_root'."
  [[ ! -L "$plugins_dir" ]] || fail "Refusing to use symlinked plugins directory '$plugins_dir'."
  mkdir -p "$plugins_dir" || fail "Could not create plugins directory '$plugins_dir'."
  [[ ! -L "$destination" ]] || fail "Refusing to replace symlink '$destination'."
  if [[ -e "$destination" ]]; then
    has_owner_marker || fail "Refusing to replace existing unowned path '$destination'."
    stage=$(mktemp -d "$config_root/.${plugin_name}.stage.XXXXXXXX") || fail "Could not create a staging directory under '$config_root'."
    staging_dir="$stage"
    trap cleanup_stage EXIT HUP INT TERM
    build_stage "$stage/$plugin_name"
    if diff -qr "$stage/$plugin_name" "$destination" >/dev/null; then
      print -- 'FM PCC Router for OpenCode is already installed.'
      return 0
    fi
    fail "An owned installation already exists with different files. Remove the installed router before reinstalling."
  fi

  stage=$(mktemp -d "$config_root/.${plugin_name}.stage.XXXXXXXX") || fail "Could not create a staging directory under '$config_root'."
  staging_dir="$stage"
  trap cleanup_stage EXIT HUP INT TERM
  build_stage "$stage/$plugin_name"
  mv -n -- "$stage/$plugin_name" "$plugins_dir/" || fail "Could not move the staged plugin into '$destination'."
  [[ ! -e "$stage/$plugin_name" ]] || fail "Install destination '$destination' appeared during installation; no files were replaced."
  print -- "Installed FM PCC Router for OpenCode to '$destination'."
  print -- 'OpenCode discovers the plugin on its next start.'
}

build_stage() {
  local stage="$1" rel
  mkdir -p "$stage" || fail 'Could not prepare the staging directory.'
  for rel in $source_files; do
    mkdir -p "$stage/${rel:h}"
    cp -p -- "$project_root/$rel" "$stage/$rel" || fail "Could not copy '$rel'."
  done
  print -r -- "$marker_value" > "$stage/$marker_name" || fail 'Could not write the ownership marker.'
  chmod 755 "$stage/integrations/opencode/manage.zsh" || fail 'Could not set launcher permissions.'
}

uninstall_plugin() {
  [[ ! -L "$config_root" ]] || fail "Refusing to use symlinked OpenCode config directory '$config_root'."
  [[ ! -L "$plugins_dir" ]] || fail "Refusing to use symlinked plugins directory '$plugins_dir'."
  [[ ! -L "$destination" ]] || fail "Refusing to remove symlink '$destination'."
  if [[ ! -e "$destination" ]]; then
    print -- 'FM PCC Router for OpenCode is not installed.'
    return 0
  fi
  check_owned_contents
  rm -rf -- "$destination" || fail "Could not remove owned plugin directory '$destination'."
  print -- "Removed FM PCC Router for OpenCode from '$destination'."
}

case "${1:-}" in
  install) install_plugin ;;
  uninstall) uninstall_plugin ;;
  *) fail 'Specify install or uninstall.' ;;
esac
