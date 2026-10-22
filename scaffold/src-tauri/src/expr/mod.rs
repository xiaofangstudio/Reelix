//! 表达式引擎（自包含，对齐 AE 表达式最常用子集）。
//!
//! 支持：
//! - 数字字面量、四则运算、乘方 `^`、取模 `%`、括号；
//! - 比较 `> < >= <= == !=` 与三目 `a > b ? x : y`；
//! - 函数：sin / cos / tan / abs / floor / ceil / round / sqrt / min / max /
//!   clamp / random / wiggle / linear / degreesToRadians / radiansToDegrees；
//! - 变量：`time`（帧时间秒）、`seed`（稳定伪随机种子，由调用方给）。
//!
//! 刻意不做（EC 的 expr crate 深度耦合它的 keyframe/project/render 内部类型，
//! 照搬不了；以下属于后续迭代）：
//! - 属性引用 `thisLayer.position` / `thisComp.layer("x")`；
//! - loopOut / loopIn / valueAtTime 等时间类函数；
//! - 矢量运算与字符串拼接。
//!
//! 求值失败一律返回 Err，调用方回落默认值——表达式写错不会让合成崩。

use std::collections::HashMap;

/// 求值入口。`vars` 可注入 time / seed 等变量。
pub fn eval(text: &str, vars: &[(&str, f64)]) -> Result<f64, String> {
    let tokens = tokenize(text)?;
    let mut parser = Parser::new(tokens);
    let ast = parser.parse_expr()?;
    if !parser.at_end() {
        return Err(format!("表达式末尾有多余内容：{:?}", parser.peek()));
    }
    let env: HashMap<String, f64> = vars.iter().map(|(k, v)| (k.to_string(), *v)).collect();
    eval_node(&ast, &env)
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Num(f64),
    Ident(String),
    Plus,
    Minus,
    Star,
    Slash,
    Percent,
    Caret,
    LParen,
    RParen,
    Comma,
    Gt,
    Lt,
    Ge,
    Le,
    Eq,
    Ne,
    Question,
    Colon,
}

fn tokenize(text: &str) -> Result<Vec<Tok>, String> {
    let mut out = Vec::new();
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            ' ' | '\t' | '\n' | '\r' => i += 1,
            '0'..='9' | '.' => {
                let start = i;
                let mut seen_dot = false;
                while i < chars.len() && (chars[i].is_ascii_digit() || (chars[i] == '.' && !seen_dot)) {
                    if chars[i] == '.' {
                        seen_dot = true;
                    }
                    i += 1;
                }
                let s: String = chars[start..i].iter().collect();
                let n: f64 = s
                    .parse()
                    .map_err(|_| format!("数字解析失败：{s}"))?;
                out.push(Tok::Num(n));
            }
            'a'..='z' | 'A'..='Z' | '_' => {
                let start = i;
                while i < chars.len() && (chars[i].is_alphanumeric() || chars[i] == '_') {
                    i += 1;
                }
                let s: String = chars[start..i].iter().collect();
                out.push(Tok::Ident(s));
            }
            '+' => {
                out.push(Tok::Plus);
                i += 1;
            }
            '-' => {
                out.push(Tok::Minus);
                i += 1;
            }
            '*' => {
                out.push(Tok::Star);
                i += 1;
            }
            '/' => {
                out.push(Tok::Slash);
                i += 1;
            }
            '%' => {
                out.push(Tok::Percent);
                i += 1;
            }
            '^' => {
                out.push(Tok::Caret);
                i += 1;
            }
            '(' => {
                out.push(Tok::LParen);
                i += 1;
            }
            ')' => {
                out.push(Tok::RParen);
                i += 1;
            }
            ',' => {
                out.push(Tok::Comma);
                i += 1;
            }
            '>' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    out.push(Tok::Ge);
                    i += 2;
                } else {
                    out.push(Tok::Gt);
                    i += 1;
                }
            }
            '<' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    out.push(Tok::Le);
                    i += 2;
                } else {
                    out.push(Tok::Lt);
                    i += 1;
                }
            }
            '=' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    out.push(Tok::Eq);
                    i += 2;
                } else {
                    return Err("等号请写 ==".into());
                }
            }
            '!' => {
                if i + 1 < chars.len() && chars[i + 1] == '=' {
                    out.push(Tok::Ne);
                    i += 2;
                } else {
                    return Err("感叹号只能用于 !=".into());
                }
            }
            '?' => {
                out.push(Tok::Question);
                i += 1;
            }
            ':' => {
                out.push(Tok::Colon);
                i += 1;
            }
            other => return Err(format!("表达式里有不认识的字符：{other}")),
        }
    }
    Ok(out)
}

#[derive(Debug, Clone)]
enum Node {
    Num(f64),
    Var(String),
    Unary(char, Box<Node>),
    Binary(char, Box<Node>, Box<Node>),
    /// 比较（结果为 1.0 / 0.0）
    Cmp(Tok, Box<Node>, Box<Node>),
    /// 三目：cond ? a : b
    Ternary(Box<Node>, Box<Node>, Box<Node>),
    Call(String, Vec<Node>),
}

struct Parser {
    toks: Vec<Tok>,
    pos: usize,
}

impl Parser {
    fn new(toks: Vec<Tok>) -> Self {
        Self { toks, pos: 0 }
    }

    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.pos)
    }

    fn at_end(&self) -> bool {
        self.pos >= self.toks.len()
    }

    fn bump(&mut self) -> Option<Tok> {
        let t = self.toks.get(self.pos).cloned();
        self.pos += 1;
        t
    }

    fn eat(&mut self, want: &Tok) -> bool {
        if self.peek() == Some(want) {
            self.pos += 1;
            true
        } else {
            false
        }
    }

    /// 入口：三目优先级最低
    fn parse_expr(&mut self) -> Result<Node, String> {
        let cond = self.parse_cmp()?;
        if self.eat(&Tok::Question) {
            let a = self.parse_expr()?;
            if !self.eat(&Tok::Colon) {
                return Err("三目表达式缺少 ':'".into());
            }
            let b = self.parse_expr()?;
            return Ok(Node::Ternary(Box::new(cond), Box::new(a), Box::new(b)));
        }
        Ok(cond)
    }

    fn parse_cmp(&mut self) -> Result<Node, String> {
        let mut left = self.parse_add()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Gt) => Tok::Gt,
                Some(Tok::Lt) => Tok::Lt,
                Some(Tok::Ge) => Tok::Ge,
                Some(Tok::Le) => Tok::Le,
                Some(Tok::Eq) => Tok::Eq,
                Some(Tok::Ne) => Tok::Ne,
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_add()?;
            left = Node::Cmp(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_add(&mut self) -> Result<Node, String> {
        let mut left = self.parse_mul()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Plus) => '+',
                Some(Tok::Minus) => '-',
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_mul()?;
            left = Node::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_mul(&mut self) -> Result<Node, String> {
        let mut left = self.parse_unary()?;
        loop {
            let op = match self.peek() {
                Some(Tok::Star) => '*',
                Some(Tok::Slash) => '/',
                Some(Tok::Percent) => '%',
                _ => break,
            };
            self.pos += 1;
            let right = self.parse_unary()?;
            left = Node::Binary(op, Box::new(left), Box::new(right));
        }
        Ok(left)
    }

    fn parse_unary(&mut self) -> Result<Node, String> {
        if let Some(Tok::Minus) = self.peek() {
            self.pos += 1;
            let inner = self.parse_unary()?;
            return Ok(Node::Unary('-', Box::new(inner)));
        }
        if let Some(Tok::Plus) = self.peek() {
            self.pos += 1;
            return self.parse_unary();
        }
        self.parse_pow()
    }

    fn parse_pow(&mut self) -> Result<Node, String> {
        let left = self.parse_atom()?;
        if let Some(Tok::Caret) = self.peek() {
            self.pos += 1;
            let right = self.parse_unary()?; // 右结合
            return Ok(Node::Binary('^', Box::new(left), Box::new(right)));
        }
        Ok(left)
    }

    fn parse_atom(&mut self) -> Result<Node, String> {
        match self.bump() {
            Some(Tok::Num(n)) => Ok(Node::Num(n)),
            Some(Tok::LParen) => {
                let inner = self.parse_expr()?;
                if !self.eat(&Tok::RParen) {
                    return Err("缺少右括号".into());
                }
                Ok(inner)
            }
            Some(Tok::Ident(name)) => {
                if self.peek() == Some(&Tok::LParen) {
                    self.pos += 1;
                    let mut args = Vec::new();
                    if self.peek() != Some(&Tok::RParen) {
                        loop {
                            let a = self.parse_expr()?;
                            args.push(a);
                            if !self.eat(&Tok::Comma) {
                                break;
                            }
                        }
                    }
                    if !self.eat(&Tok::RParen) {
                        return Err(format!("函数 {name} 缺少右括号"));
                    }
                    return Ok(Node::Call(name, args));
                }
                Ok(Node::Var(name))
            }
            other => Err(format!("表达式不完整，遇到：{other:?}")),
        }
    }
}

fn eval_node(node: &Node, env: &HashMap<String, f64>) -> Result<f64, String> {
    match node {
        Node::Num(n) => Ok(*n),
        Node::Var(name) => {
            // 常量
            match name.as_str() {
                "PI" => return Ok(std::f64::consts::PI),
                "E" => return Ok(std::f64::consts::E),
                _ => {}
            }
            env.get(name)
                .copied()
                .ok_or_else(|| format!("表达式里没有这个变量：{name}"))
        }
        Node::Unary(op, inner) => {
            let v = eval_node(inner, env)?;
            Ok(if *op == '-' { -v } else { v })
        }
        Node::Binary(op, a, b) => {
            let x = eval_node(a, env)?;
            let y = eval_node(b, env)?;
            Ok(match op {
                '+' => x + y,
                '-' => x - y,
                '*' => x * y,
                '/' => x / y,
                '%' => x % y,
                '^' => x.powf(y),
                _ => return Err("内部错误：未知运算符".into()),
            })
        }
        Node::Cmp(op, a, b) => {
            let x = eval_node(a, env)?;
            let y = eval_node(b, env)?;
            let r = match op {
                Tok::Gt => x > y,
                Tok::Lt => x < y,
                Tok::Ge => x >= y,
                Tok::Le => x <= y,
                Tok::Eq => (x - y).abs() < f64::EPSILON,
                Tok::Ne => (x - y).abs() >= f64::EPSILON,
                _ => return Err("内部错误：未知比较".into()),
            };
            Ok(if r { 1.0 } else { 0.0 })
        }
        Node::Ternary(c, a, b) => {
            if eval_node(c, env)? > 0.5 {
                eval_node(a, env)
            } else {
                eval_node(b, env)
            }
        }
        Node::Call(name, args) => {
            let mut vals = Vec::with_capacity(args.len());
            for a in args {
                vals.push(eval_node(a, env)?);
            }
            call(name, &vals, env)
        }
    }
}

/// 函数库。参数个数不对一律报错（写错表达式就该看到错误）。
fn call(name: &str, a: &[f64], env: &HashMap<String, f64>) -> Result<f64, String> {
    let need = |n: usize| -> Result<(), String> {
        if a.len() == n {
            Ok(())
        } else {
            Err(format!("函数 {name} 需要 {n} 个参数，给了 {}", a.len()))
        }
    };
    match name {
        "sin" => {
            need(1)?;
            Ok(a[0].sin())
        }
        "cos" => {
            need(1)?;
            Ok(a[0].cos())
        }
        "tan" => {
            need(1)?;
            Ok(a[0].tan())
        }
        "abs" => {
            need(1)?;
            Ok(a[0].abs())
        }
        "sqrt" => {
            need(1)?;
            Ok(a[0].max(0.0).sqrt())
        }
        "floor" => {
            need(1)?;
            Ok(a[0].floor())
        }
        "ceil" => {
            need(1)?;
            Ok(a[0].ceil())
        }
        "round" => {
            need(1)?;
            Ok(a[0].round())
        }
        "min" => {
            if a.is_empty() {
                return Err("min 至少一个参数".into());
            }
            Ok(a.iter().cloned().fold(f64::INFINITY, f64::min))
        }
        "max" => {
            if a.is_empty() {
                return Err("max 至少一个参数".into());
            }
            Ok(a.iter().cloned().fold(f64::NEG_INFINITY, f64::max))
        }
        "clamp" => {
            need(3)?;
            Ok(a[0].clamp(a[1], a[2]))
        }
        "random" => {
            // 无参：0~1 稳定伪随机（seed 由 env 提供，默认 0）
            if a.is_empty() {
                let seed = env.get("seed").copied().unwrap_or(0.0);
                Ok(hash01(seed))
            } else if a.len() == 1 {
                Ok(hash01(env_seed(a)) * a[0])
            } else {
                need(2)?;
                let r = frac(hash01(env_seed(a)));
                Ok(a[0] + (a[1] - a[0]) * r)
            }
        }
        "wiggle" => {
            // wiggle(freq, amp)：简化为「按 seed 抖动」的静态近似
            // （真实 wiggle 随时间连续抖动，留给下轮 time 接入）
            need(2)?;
            Ok(a[1] * frac(hash01(env_seed(a))))
        }
        "linear" => {
            // linear(t, inMin, inMax, outMin, outMax)
            need(5)?;
            let t = ((a[0] - a[1]) / (a[2] - a[1]).max(f64::EPSILON)).clamp(0.0, 1.0);
            Ok(a[3] + (a[4] - a[3]) * t)
        }
        "degreesToRadians" => {
            need(1)?;
            Ok(a[0].to_radians())
        }
        "radiansToDegrees" => {
            need(1)?;
            Ok(a[0].to_degrees())
        }
        _ => Err(format!("表达式里没有这个函数：{name}")),
    }
}

fn env_seed(a: &[f64]) -> f64 {
    // 参数末值当种子，让 random(x) 随参数变化而不同
    a.last().copied().unwrap_or(0.0)
}

/// 取小数部分（0~1）。
fn frac(x: f64) -> f64 {
    let s = x.sin() * 43758.5453;
    s - s.floor()
}

/// 稳定哈希 → [0,1)。
fn hash01(seed: f64) -> f64 {
    let mut h = seed.to_bits();
    h ^= 0x9E3779B97F4A7C15;
    h = h.wrapping_mul(0xBF58476D1CE4E5B9);
    h ^= h >> 31;
    h = h.wrapping_mul(0x94D049BB133111EB);
    h ^= h >> 31;
    (h >> 11) as f64 / (1u64 << 53) as f64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(s: &str) -> f64 {
        eval(s, &[("time", 0.0), ("seed", 7.0)]).expect("应求值成功")
    }

    #[test]
    fn arithmetic_and_precedence() {
        assert!((ev("1 + 2 * 3") - 7.0).abs() < 1e-9);
        assert!((ev("(1 + 2) * 3") - 9.0).abs() < 1e-9);
        assert!((ev("2 ^ 3 ^ 2") - 512.0).abs() < 1e-6); // 右结合
        assert!((ev("-3 + 1") - -2.0).abs() < 1e-9);
        assert!((ev("10 % 3") - 1.0).abs() < 1e-9);
    }

    #[test]
    fn functions_and_compare() {
        assert!((ev("abs(-5)") - 5.0).abs() < 1e-9);
        assert!((ev("max(1, 7, 3)") - 7.0).abs() < 1e-9);
        assert!((ev("clamp(15, 0, 10)") - 10.0).abs() < 1e-9);
        assert!((ev("floor(2.7)") - 2.0).abs() < 1e-9);
        assert!((ev("1 > 2 ? 10 : 20") - 20.0).abs() < 1e-9);
        assert!((ev("5 >= 5") - 1.0).abs() < 1e-9);
        assert!((ev("sin(0)") - 0.0).abs() < 1e-9);
        assert!((ev("linear(0.5, 0, 1, 0, 100)") - 50.0).abs() < 1e-9);
    }

    #[test]
    fn random_is_stable() {
        let a = ev("random()");
        let b = ev("random()");
        assert!((a - b).abs() < 1e-12, "同一 seed 下 random 必须稳定");
        let c = eval("random()", &[("time", 0.0), ("seed", 99.0)]).unwrap();
        assert!((a - c).abs() > 1e-6, "不同 seed 应给不同值");
    }

    #[test]
    fn bad_expressions_error_not_panic() {
        assert!(eval("1 +", &[]).is_err());
        assert!(eval("foo(1)", &[]).is_err());
        assert!(eval("1 @ 2", &[]).is_err());
        assert!(eval("(1 + 2", &[]).is_err());
        assert!(eval("", &[]).is_err());
    }
}

/// 表达式求值（关键帧曲线的表达式 easing 用）：变量 t ∈ [0,1]。
#[tauri::command]
pub fn eval_expr(text: String, t: f64) -> Result<f64, String> {
    eval(&text, &[("t", t.clamp(0.0, 1.0))])
}
