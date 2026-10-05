// sqlx::migrate! embeds the migrations directory at compile time, and cargo
// has no idea the macro read those files — so adding 0004_*.sql silently
// ships a binary without it. This is the documented sqlx incantation.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
