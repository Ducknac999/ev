#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ev_lib::print_memory_and_exit();
    ev_lib::check_permissions_and_exit();
    ev_lib::check_background_and_exit();
    ev_lib::notch_look_and_exit();
    ev_lib::documents_and_exit();
    ev_lib::voice_serve_and_exit();
    ev_lib::run()
}
