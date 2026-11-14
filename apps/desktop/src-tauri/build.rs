fn main() {
    // Listing app commands makes tauri-build generate an `allow-<command>`
    // permission for each, so capabilities can grant them per window.
    // Keep in sync with `specta_builder()` in src/lib.rs.
    let manifest = tauri_build::AppManifest::new().commands(&[
        "get_settings",
        "get_shortcut_status",
        "set_capture_shortcut",
        "open_print_screen_setting",
        "set_theme",
        "get_autostart",
        "set_autostart",
        "set_save_history",
        "set_exclude_from_clipboard_history",
        "list_history",
        "get_history_thumbnail",
        "copy_history_image",
        "delete_history_image",
        "delete_all_history",
        "open_history_in_editor",
        "get_chat",
        "save_chat",
        "get_editor_image",
        "quick_save",
        "choose_save_as_path",
        "write_save_as",
        "copy_rendered_image",
        "start_drag",
        "reveal_saved_file",
        "choose_save_folder",
        "reset_save_folder",
        "open_sponsors_page",
        "list_user_presets",
        "save_user_preset",
        "delete_user_preset",
        "save_preset_file",
        "list_background_images",
        "add_background_image",
        "read_background_image",
        "delete_background_image",
        "ai_run",
        "ai_cancel",
        "ai_detect",
        "set_ai_provider",
        "set_ai_allow_images",
        "set_ai_effort",
        "dismiss_ai_onboarding",
        "open_ai_install_guide",
        "open_login_terminal",
        "answer_autostart_question",
        "get_main_view",
        "request_capture",
    ]);

    // tauri-build embeds its Windows manifest (Common Controls v6) only into
    // the app binary, so `cargo test` binaries that link tauri die at start
    // with STATUS_ENTRYPOINT_NOT_FOUND (comctl32 v5 lacks TaskDialogIndirect).
    // Embed the same manifest through the linker instead. `rustc-link-arg`
    // (unlike `-bins` / `-tests`) also reaches the lib's unit-test binary.
    let windows = tauri_build::WindowsAttributes::new_without_app_manifest();
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        let path = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
            .join("windows-app-manifest.xml");
        println!("cargo:rerun-if-changed=windows-app-manifest.xml");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", path.display());
    }

    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(manifest)
            .windows_attributes(windows),
    )
    .expect("failed to run tauri-build");
}
