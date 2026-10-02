//! Product identity, mirrored from `src/shared/product.ts`. A test keeps both
//! in step; neither value may change (the app id keys installs and profiles).

/// The GUI's product name, for app identity and fallbacks.
pub const PRODUCT_NAME: &str = "Sai ATLAS";

/// The OS-level app id (bundle id, AppUserModelID, packaging appId).
pub const APP_ID: &str = "vn.io.vif.saiatlas";

#[cfg(test)]
mod tests {
    use super::*;

    const SHARED_PRODUCT_TS: &str = include_str!("../../src/shared/product.ts");

    fn ts_constant(name: &str) -> String {
        let pattern = regex::Regex::new(&format!(r#"export const {name} = "([^"]+)""#)).unwrap();
        pattern
            .captures(SHARED_PRODUCT_TS)
            .and_then(|captures| captures.get(1))
            .map(|value| value.as_str().to_string())
            .unwrap_or_else(|| panic!("{name} is not declared in src/shared/product.ts"))
    }

    #[test]
    fn mirrors_the_shared_product_constants() {
        assert_eq!(PRODUCT_NAME, ts_constant("PRODUCT_NAME"));
        assert_eq!(APP_ID, ts_constant("APP_ID"));
    }
}
